"""Rodada de medição da fase 3.

Para cada número de engines e de entregadores: escala o engine, sobe o gerador de carga em rampa,
abre os espectadores (k6), espera a janela estável e lê o Prometheus só nessa janela. Grava um CSV
por rodada e os gráficos em SVG a partir dele.

    python3 bench/escala.py --engines 1,2,4 --couriers 5000,10000,20000
    python3 bench/escala.py --chart docs/escala/rodada.csv   # só refaz os gráficos

Precisa do stack no ar com o perfil obs (Prometheus em 127.0.0.1:9090).
"""

import argparse
import csv
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROMETHEUS = "http://127.0.0.1:9090"
K6_IMAGE = "grafana/k6:2.3.0"
NETWORK = "gdrive_default"

# Critério de "aguenta", o mesmo do plano da fase 3.
MIN_ACCEPTED = 0.99
MAX_FANOUT_P99 = 0.25


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def compose(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", "compose", *args],
        cwd=ROOT,
        env={**os.environ, **(env or {})},
        check=True,
        capture_output=True,
        text=True,
    )


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True)


def query(expr: str) -> list[dict]:
    url = f"{PROMETHEUS}/api/v1/query?" + urllib.parse.urlencode({"query": expr})
    with urllib.request.urlopen(url, timeout=10) as resp:
        body = json.load(resp)
    if body.get("status") != "success":
        raise RuntimeError(f"Prometheus recusou {expr!r}: {body}")
    return body["data"]["result"]


def value(expr: str) -> float:
    """Soma do resultado; NaN (histograma sem amostra na janela) vira 0."""
    total = 0.0
    for sample in query(expr):
        v = float(sample["value"][1])
        if not math.isnan(v):
            total += v
    return total


def by_instance(expr: str) -> dict[str, float]:
    return {s["metric"].get("instance", "?"): float(s["value"][1]) for s in query(expr)}


def scale(engines: int) -> None:
    env = {"ENGINE_REPLICAS": str(engines)}
    compose("up", "-d", "--no-deps", "--scale", f"engine={engines}", "engine", env=env)
    deadline = time.time() + 120
    while time.time() < deadline:
        ps = compose("ps", "engine", "--format", "json").stdout
        rows = [json.loads(line) for line in ps.splitlines() if line.strip()]
        if len(rows) == engines and all("healthy" in r.get("Status", "") for r in rows):
            break
        time.sleep(2)
    else:
        raise RuntimeError(f"engine não chegou a {engines} instâncias saudáveis")
    # O nginx resolve `engine` a cada 10 s e o Prometheus descobre os alvos a cada 5 s.
    time.sleep(20)
    found = value('count(up{job="engine"} == 1)')
    if found != engines:
        raise RuntimeError(f"Prometheus vê {found:.0f} engines, esperava {engines}")


def wait_exit(container: str, timeout: float) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = docker("inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", container, check=False)
        if state.returncode != 0:
            return 0
        status, code = state.stdout.split()
        if status == "exited":
            return int(code)
        time.sleep(2)
    raise RuntimeError(f"{container} não terminou em {timeout:.0f} s")


def point(engines: int, couriers: int, args: argparse.Namespace, out: Path, stem: str) -> dict:
    ramp = math.ceil(couriers / args.ramp_step) * args.ramp_every
    total = ramp + args.warm + args.hold + 20
    env = {
        "ENGINE_REPLICAS": str(engines),
        "LOAD_COURIERS": str(couriers),
        "LOAD_RAMP_STEP": str(args.ramp_step),
        "LOAD_RAMP_EVERY": f"{args.ramp_every}s",
        "LOAD_DURATION": f"{total}s",
        "LOAD_BUSY_RATIO": str(args.busy),
    }
    log(f"{engines} engine(s), {couriers} entregadores: rampa de {ramp} s")
    compose("--profile", "load", "up", "-d", "--no-deps", "--force-recreate", "load", env=env)
    load = compose("--profile", "load", "ps", "-q", "load", env=env).stdout.strip()
    time.sleep(ramp + args.warm)

    k6 = f"gdrive-k6-{engines}-{couriers}"
    docker("rm", "-f", k6, check=False)
    docker(
        "run", "-d", "--name", k6, "--network", NETWORK, "--user", f"{os.getuid()}:{os.getgid()}",
        "-v", f"{ROOT / 'bench' / 'k6'}:/scripts:ro", "-v", f"{out}:/out",
        "-e", f"HOLD_SECONDS={args.hold}", "-e", f"CENTRALS={args.centrals}", "-e", f"WATCHERS={args.watchers}",
        K6_IMAGE, "run", "--quiet", "/scripts/espectadores.js",
    )  # fmt: skip
    log(f"janela estável de {args.hold} s")
    time.sleep(args.hold)

    w = f"{args.hold}s"
    cpu = by_instance(f'rate(process_cpu_seconds_total{{job="engine"}}[{w}])')
    row = {
        "engines": engines,
        "entregadores": couriers,
        "enviadas_s": value(f"sum(rate(gdrive_load_positions_sent_total[{w}]))"),
        "aceitas_s": value(f"sum(rate(gdrive_positions_received_total[{w}]))"),
        "update_p99_ms": 1000 * value(f"histogram_quantile(0.99, sum by (le) (rate(gdrive_position_update_seconds_bucket[{w}])))"),
        "fanout_p99_ms": 1000 * value(f"histogram_quantile(0.99, sum by (le) (rate(gdrive_position_fanout_seconds_bucket[{w}])))"),
        "cpu_engines": sum(cpu.values()),
        "cpu_engine_max": max(cpu.values(), default=0.0),
        "cpu_redis": value(f"rate(redis_cpu_sys_seconds_total[{w}]) + rate(redis_cpu_user_seconds_total[{w}])"),
        "redis_ops_s": value(f"rate(redis_commands_processed_total[{w}])"),
        "retrato_bytes": value("max(gdrive_snapshot_bytes)"),
        "retrato_build_p99_ms": 1000 * value(f"histogram_quantile(0.99, sum by (le) (rate(gdrive_snapshot_build_seconds_bucket[{w}])))"),
        "descartes_central": value(f'sum(increase(gdrive_ws_dropped_total{{kind="central"}}[{w}]))'),
        "descartes_pedido": value(f'sum(increase(gdrive_ws_dropped_total{{kind="order"}}[{w}]))'),
        "falhas_gerador": value(f"sum(increase(gdrive_load_errors_total[{w}]))"),
        "despacho_oferta": value(f'sum(increase(gdrive_dispatch_seconds_count{{result="oferta"}}[{w}]))'),
        "despacho_aguardando": value(f'sum(increase(gdrive_dispatch_seconds_count{{result="aguardando"}}[{w}]))'),
    }  # fmt: skip

    if wait_exit(k6, 120) == 0 and (out / "k6.json").exists():
        spectators = json.loads((out / "k6.json").read_text())
        (out / "k6.json").rename(out / f"{stem}-k6-{engines}-{couriers}.json")
        row["retrato_intervalo_p99_ms"] = spectators.get("retrato_intervalo_p99_ms")
    else:
        row["retrato_intervalo_p99_ms"] = None
    docker("rm", "-f", k6, check=False)
    if load:
        wait_exit(load, total + 120)

    row = {k: round(v, 2) if isinstance(v, float) else v for k, v in row.items()}
    sent = row["enviadas_s"]
    row["passou"] = (
        sent > 0
        and row["aceitas_s"] >= MIN_ACCEPTED * sent
        and row["fanout_p99_ms"] / 1000 < MAX_FANOUT_P99
        and row["descartes_central"] < 1
        and row["falhas_gerador"] == 0
    )
    log(
        f"aceitas {row['aceitas_s']:.0f}/s de {sent:.0f}/s, fan-out p99 {row['fanout_p99_ms']:.1f} ms, "
        f"CPU engines {row['cpu_engines']:.2f}, Redis {row['cpu_redis']:.2f}: {'passou' if row['passou'] else 'NÃO passou'}"
    )
    return row


def machine() -> dict:
    model = ""
    if Path("/proc/cpuinfo").exists():
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                model = line.split(":", 1)[1].strip()
                break
    mem = 0
    if Path("/proc/meminfo").exists():
        mem = int(Path("/proc/meminfo").read_text().split()[1]) // 1024
    return {
        "cpu": model,
        "nucleos": os.cpu_count(),
        "memoria_mb": mem,
        "sistema": f"{platform.system()} {platform.release()}",
        "docker": docker("version", "--format", "{{.Server.Version}}", check=False).stdout.strip(),
    }


# ---------- gráficos: SVG à mão, sem dependência para instalar


COLORS = ["#00ADD8", "#E3C45C", "#4CC38A", "#EC6A5E", "#9FB3C3"]


def nice(top: float) -> tuple[float, float]:
    """Topo e passo redondos para o eixo: 1, 2, 2,5 ou 5 vezes uma potência de 10."""
    raw = max(top, 1e-9) / 5
    power = 10 ** math.floor(math.log10(raw))
    step = next(m * power for m in (1, 2, 2.5, 5, 10) if m * power >= raw)
    return step * math.ceil(top / step), step


def br(v: float) -> str:
    text = f"{v:,.0f}" if v >= 10 or v == int(v) else f"{v:,.1f}"
    return text.replace(",", "_").replace(".", ",").replace("_", ".")


def chart(rows: list[dict], key: str, title: str, unit: str, path: Path, ideal: bool = False) -> None:
    w, h, left, right, top, bottom = 720, 440, 72, 24, 76, 56
    xs = sorted({int(r["entregadores"]) for r in rows})
    series: dict[int, list[tuple[int, float]]] = {}
    for r in rows:
        series.setdefault(int(r["engines"]), []).append((int(r["entregadores"]), float(r[key])))
    y_top, y_step = nice(max([float(r[key]) for r in rows] + ([xs[-1] / 2] if ideal else [])) * 1.05)
    x_max = xs[-1] * 1.05

    def px(x: float) -> float:
        return left + (w - left - right) * x / x_max

    def py(y: float) -> float:
        return h - bottom - (h - top - bottom) * y / y_top

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" font-family="IBM Plex Sans, sans-serif" font-size="12">',
        f'<rect width="{w}" height="{h}" fill="#0A1B2A"/>',
        f'<text x="{left}" y="28" fill="#EEF2F5" font-size="15" font-weight="600">{title}</text>',
    ]
    steps = round(y_top / y_step)
    for i in range(steps + 1):
        y = y_step * i
        out.append(f'<line x1="{left}" x2="{w - right}" y1="{py(y):.1f}" y2="{py(y):.1f}" stroke="#1D364C"/>')
        out.append(f'<text x="{left - 8}" y="{py(y) + 4:.1f}" fill="#9FB3C3" text-anchor="end">{br(y)}</text>')
    for x in xs:
        out.append(f'<text x="{px(x):.1f}" y="{h - bottom + 20}" fill="#9FB3C3" text-anchor="middle">{br(x)}</text>')
    out.append(f'<text x="{(left + w - right) / 2}" y="{h - 12}" fill="#9FB3C3" text-anchor="middle">entregadores conectados</text>')
    middle = (top + h - bottom) / 2
    out.append(f'<text x="16" y="{middle}" fill="#9FB3C3" text-anchor="middle" transform="rotate(-90 16 {middle})">{unit}</text>')
    # Legenda numa linha abaixo do título, fora da área dos dados.
    legend_x = left
    if ideal:
        out.append(f'<line x1="{px(0)}" y1="{py(0)}" x2="{px(xs[-1]):.1f}" y2="{py(xs[-1] / 2):.1f}" stroke="#668096" stroke-dasharray="4 4"/>')
    for i, (engines, points) in enumerate(sorted(series.items())):
        color = COLORS[i % len(COLORS)]
        coords = " ".join(f"{px(x):.1f},{py(y):.1f}" for x, y in sorted(points))
        out.append(f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="2.5"/>')
        for x, y in points:
            out.append(f'<circle cx="{px(x):.1f}" cy="{py(y):.1f}" r="3.5" fill="{color}"/>')
        label = f"{engines} engine" if engines == 1 else f"{engines} engines"
        out.append(f'<rect x="{legend_x}" y="47" width="14" height="3" fill="{color}"/>')
        out.append(f'<text x="{legend_x + 20}" y="52" fill="#EEF2F5">{label}</text>')
        legend_x += 100
    if ideal:
        out.append(f'<line x1="{legend_x}" x2="{legend_x + 14}" y1="48.5" y2="48.5" stroke="#668096" stroke-dasharray="4 4"/>')
        out.append(f'<text x="{legend_x + 20}" y="52" fill="#9FB3C3">1 posição a cada 2 s por entregador</text>')
    out.append("</svg>")
    path.write_text("\n".join(out) + "\n")


def charts(csv_path: Path) -> None:
    with csv_path.open() as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return
    base = csv_path.with_suffix("")
    chart(rows, "aceitas_s", "Posições aceitas por segundo", "posições/s", base.with_name(base.name + "-posicoes.svg"), ideal=True)
    chart(rows, "fanout_p99_ms", "Fan-out entre instâncias, p99", "ms", base.with_name(base.name + "-fanout.svg"))
    chart(rows, "cpu_engines", "CPU somada dos engines", "núcleos", base.with_name(base.name + "-cpu.svg"))
    log(f"gráficos em {base.parent}")


def compare(before: Path, after: Path, couriers: int, out: Path) -> None:
    """Barras do p99 do fan-out por número de engines, antes e depois, num mesmo volume."""
    rows = {}
    for label, path in (("antes", before), ("depois", after)):
        with path.open() as f:
            for r in csv.DictReader(f):
                if int(r["entregadores"]) == couriers:
                    rows[(label, int(r["engines"]))] = float(r["fanout_p99_ms"])
    engines = sorted({e for _, e in rows})
    w, h, left, right, top, bottom = 720, 440, 72, 24, 76, 56
    y_top, y_step = nice(max(rows.values()) * 1.05)
    group = (w - left - right) / len(engines)
    bar = group / 3

    def py(y: float) -> float:
        return h - bottom - (h - top - bottom) * y / y_top

    out_lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" font-family="IBM Plex Sans, sans-serif" font-size="12">',
        f'<rect width="{w}" height="{h}" fill="#0A1B2A"/>',
        f'<text x="{left}" y="28" fill="#EEF2F5" font-size="15" font-weight="600">Fan-out p99 com {br(couriers)} entregadores</text>',
        f'<rect x="{left}" y="47" width="14" height="10" fill="#EC6A5E"/><text x="{left + 20}" y="56" fill="#EEF2F5">uma ida ao Redis por posição</text>',
        f'<rect x="{left + 230}" y="47" width="14" height="10" fill="#00ADD8"/><text x="{left + 250}" y="56" fill="#EEF2F5">gravação em lote</text>',
    ]
    for i in range(round(y_top / y_step) + 1):
        y = y_step * i
        out_lines.append(f'<line x1="{left}" x2="{w - right}" y1="{py(y):.1f}" y2="{py(y):.1f}" stroke="#1D364C"/>')
        out_lines.append(f'<text x="{left - 8}" y="{py(y) + 4:.1f}" fill="#9FB3C3" text-anchor="end">{br(y)}</text>')
    if y_top > MAX_FANOUT_P99 * 1000:
        limit = py(MAX_FANOUT_P99 * 1000)
        out_lines.append(f'<line x1="{left}" x2="{w - right}" y1="{limit:.1f}" y2="{limit:.1f}" stroke="#E3C45C" stroke-dasharray="6 4"/>')
        out_lines.append(f'<text x="{w - right}" y="{limit - 6:.1f}" fill="#E3C45C" text-anchor="end">limite de 250 ms</text>')
    for i, engines_n in enumerate(engines):
        x0 = left + group * i + bar / 2
        for j, (label, color) in enumerate((("antes", "#EC6A5E"), ("depois", "#00ADD8"))):
            v = rows.get((label, engines_n))
            if v is None:
                continue
            x = x0 + j * bar
            out_lines.append(f'<rect x="{x:.1f}" y="{py(v):.1f}" width="{bar - 6:.1f}" height="{py(0) - py(v):.1f}" fill="{color}"/>')
            out_lines.append(f'<text x="{x + (bar - 6) / 2:.1f}" y="{py(v) - 6:.1f}" fill="#EEF2F5" text-anchor="middle">{br(v)} ms</text>')
        label = "engine" if engines_n == 1 else "engines"
        out_lines.append(f'<text x="{left + group * i + group / 2:.1f}" y="{h - bottom + 20}" fill="#9FB3C3" text-anchor="middle">{engines_n} {label}</text>')
    middle = (top + h - bottom) / 2
    out_lines.append(f'<text x="16" y="{middle}" fill="#9FB3C3" text-anchor="middle" transform="rotate(-90 16 {middle})">ms</text>')
    out_lines.append("</svg>")
    out.write_text("\n".join(out_lines) + "\n")
    log(f"comparação em {out}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engines", default="1,2,4")
    parser.add_argument("--couriers", default="5000,10000,20000")
    parser.add_argument("--hold", type=int, default=180, help="segundos de janela estável por ponto")
    parser.add_argument("--warm", type=int, default=30, help="segundos de espera depois da rampa")
    parser.add_argument("--ramp-step", type=int, default=2000)
    parser.add_argument("--ramp-every", type=int, default=10)
    parser.add_argument("--busy", type=float, default=0.4)
    parser.add_argument("--centrals", type=int, default=10)
    parser.add_argument("--watchers", type=int, default=200)
    parser.add_argument("--out", type=Path, default=ROOT / "docs" / "escala")
    parser.add_argument("--chart", type=Path, help="só refaz os gráficos deste CSV")
    parser.add_argument("--compare", type=Path, nargs=2, metavar=("ANTES", "DEPOIS"), help="barras de antes e depois")
    args = parser.parse_args()
    if args.compare:
        first = int(args.couriers.split(",")[-1])
        compare(*args.compare, first, args.out / f"comparacao-{first}.svg")
        return
    if args.chart:
        charts(args.chart)
        return
    if not shutil.which("docker"):
        sys.exit("docker não encontrado")
    query("up")

    args.out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M")
    csv_path = args.out / f"rodada-{stamp}.csv"
    (args.out / f"rodada-{stamp}-maquina.json").write_text(json.dumps(machine(), ensure_ascii=False, indent=2) + "\n")
    rows: list[dict] = []
    for engines in [int(n) for n in args.engines.split(",")]:
        scale(engines)
        for couriers in [int(c) for c in args.couriers.split(",")]:
            row = point(engines, couriers, args, args.out, csv_path.stem)
            rows.append(row)
            with csv_path.open("w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
            if not row["passou"]:
                log(f"{engines} engine(s) não aguentam {couriers}; pulando os pontos maiores")
                break
    charts(csv_path)
    log(f"CSV em {csv_path}")


if __name__ == "__main__":
    main()
