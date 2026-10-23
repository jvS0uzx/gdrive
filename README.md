# GDrive

![Fase 0: o mapa real de Salvador, uma rota da Barra até a Paralela, a chuva e a mão única de perto](docs/assets/fase-0.gif)

Simulação de despacho de delivery sobre o mapa real de Salvador. Os entregadores andam pelas
ruas de verdade seguindo rotas de um roteador próprio, o despacho oferece cada pedido ao
entregador livre que chega mais rápido à loja, e cliente, loja e central acompanham tudo ao
vivo.

O objetivo é medir, com número, até onde o sistema escala na horizontal.

> **Estado:** fase 0 concluída (mapa e roteador).
>
> **Navegador:** testado apenas no Chromium, no Linux. Google Chrome e outros navegadores não
> são testados.

## Rodar

```bash
docker compose up --build
```

Abra <http://localhost:8085>, clique na origem e depois no destino.

## Fase 0: mapa e roteador

**O mapa.** A malha viária de Salvador vem do OpenStreetMap, importada pelo `osmimport`:

| Salvador | |
|---|---|
| Nós | 156.589, dos quais 21.815 cruzamentos |
| Vias | 3.334 km em 23.994 vias, 7.139 de mão única, 163 rotatórias |
| Velocidade máxima no mapa | 2.162 vias; nas outras vale o padrão da classe |
| Lojas | 1.573 restaurantes, lanchonetes, cafés e sorveterias reais, presos ao nó mais próximo |
| Extensão | 24,8 × 24,8 km |

**O que a importação respeita:**

- Classe da via: `motorway` e `trunk` viram via expressa, `primary` avenida, `secondary` e
  `tertiary` coletora, `residential` rua, `living_street` travessa.
- Sentido: `oneway=yes`, `oneway=-1` (mão única contra o desenho da via), rotatória e
  `motorway` são mão única mesmo sem a tag.
- Acesso: via privada ou proibida para moto fica de fora.
- Velocidade: `maxspeed` quando existe; senão, o padrão da classe (expressa 80 km/h, avenida
  60, coletora 50, rua 40, travessa 30).

**Só o maior componente fortemente conexo.** Ilhas, pontas de mão única sem saída e erros de
mapeamento ficam de fora: 2.845 nós. Inverter uma mão única real para fechar a malha seria
mentir sobre a cidade, então quem sai é o pedaço desconectado.

**O roteador.** A* com peso em tempo, usando a velocidade de cada via, × fator de clima
(chuva = 1,4). A heurística é a distância em linha reta ÷ a maior velocidade da cidade, que
nunca superestima. Uma rota entre dois pontos aleatórios de Salvador leva **8,2 ms** em média
sobre os 156 mil nós (`go test -bench`).

Exemplo do GIF: da Barra até a Paralela são 17 min 11 s e 19,9 km, pela Av. Cardeal da Silva,
Av. Juracy Magalhães Júnior, Av. ACM e Av. Paralela.

Para o despacho da fase 1 já existe o Dijkstra de um para muitos: uma busca a partir da loja,
no grafo com as setas invertidas, devolve o tempo de N entregadores até ela.

**Os testes que sustentam isso:**

- A importação de um mapa de teste respeita sentido, `oneway=-1`, rotatória, acesso privado,
  `maxspeed` e descarta o que não é fortemente conexo.
- A loja vai para o cruzamento mais próximo; sem nome, longe demais ou bar ficam de fora.
- A* devolve o mesmo custo que Dijkstra em 1.000 grafos aleatórios com mão única, e em 400
  pares de pontos de Salvador.
- Em 200 rotas por Salvador, todo trecho respeita a mão única e o tempo acumulado bate.
- A Salvador versionada em `cities/salvador/` é fortemente conexa, fica dentro dos limites da
  cidade e é igual ao que a importação produz a partir da cópia local do OpenStreetMap.
- e2e no Chromium contra a pilha do `docker compose`: o mapa carrega, dois cliques traçam a
  rota com o nome das vias, a chuva deixa a rota mais lenta, clique no mar dá aviso.

## API do engine

| Rota | O que faz |
|---|---|
| `GET /city` | Nome, fonte, cruzamentos, km de vias, limites, velocidades padrão |
| `GET /city.geojson` | Todas as vias, com classe, nome e mão única na ordem das coordenadas |
| `POST /route` | `{"from":{"lat":..,"lon":..},"to":{..},"rain":false}` → tempo, distância, principais vias, caminho e tempo acumulado por nó |
| `GET /healthz` | Saúde |

Origem e destino são presos ao nó mais próximo, até 400 m. Mais longe que isso, a resposta é
`422 ponto fora da cidade`.

## Dados do mapa

Dados © colaboradores do OpenStreetMap, disponíveis sob a
[Open Database License (ODbL)](https://www.openstreetmap.org/copyright). O arquivo
`cities/salvador/city.gob.gz` é um banco de dados derivado e segue a mesma licença.

Para atualizar com a base mais recente:

```bash
cd engine
go run ./cmd/osmimport -refresh
```

O comando consulta a Overpass API, guarda a cópia bruta em `cities/salvador/osm-*.json` (fora
do git) e grava o `city.gob.gz`.

## Desenvolvimento

```bash
cd engine
go test ./...
go run ./cmd/engine -addr :8086
```

```bash
cd web
pnpm install
pnpm dev
```

O front usa Node 24 (há um `mise.toml`) e encaminha `/city` e `/route` para o engine em
`:8086`.

```bash
CHROMIUM_PATH=/usr/bin/chromium BASE_URL=http://localhost:8085 pnpm e2e
CHROMIUM_PATH=/usr/bin/chromium BASE_URL=http://localhost:8085 pnpm demo
```

## O sistema completo

| Parte | Tecnologia | Papel | Desde |
|---|---|---|---|
| `osmimport` | Go | Importa a malha e as lojas do OpenStreetMap | fase 0 |
| `engine` | Go | Roteador, WebSocket, posição, geofence; roda em N instâncias | fase 0 |
| `web` | React, TypeScript, MapLibre | Mapa da cidade | fase 0 |
| `sim` | Go | Entregadores e clientes simulados, um WebSocket real por entregador | fase 1 |
| `api` e `worker` | Python, FastAPI | Pedidos, máquina de estados, despacho, prazos | fase 1 |
| Estado | PostgreSQL + PostGIS | Fonte da verdade; outbox e jobs na transação do pedido | fase 1 |
| Tempo real | Redis | Última posição, fan-out entre instâncias, Streams de eventos | fase 1 |
| Medição | Prometheus, Grafana, k6 | Escala horizontal com número | fase 3 |

## Fases

- [x] **0. Mapa e roteador:** Salvador real e página que traça a rota mais rápida entre dois
  cliques.
- [ ] **1. Núcleo:** pedido de ponta a ponta, despacho com repasse e raio crescente,
  acompanhamento do cliente, mapa da central.
- [ ] **2. Operação:** painel da loja, entregador pelo celular, alertas, histórico com
  replay, rush e chuva.
- [ ] **3. Escala:** várias instâncias, modo carga, métricas e teste de carga.
