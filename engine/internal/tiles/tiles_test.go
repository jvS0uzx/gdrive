package tiles

import (
	"math"
	"testing"
)

type decoded struct {
	name     string
	extent   uint64
	keys     []string
	values   []any
	features []decodedFeature
}

type decodedFeature struct {
	typ   uint64
	tags  []uint64
	parts [][][2]int64
}

type reader struct {
	buf []byte
	at  int
}

func (r *reader) varint() uint64 {
	var v uint64
	for shift := 0; ; shift += 7 {
		b := r.buf[r.at]
		r.at++
		v |= uint64(b&0x7f) << shift
		if b < 0x80 {
			return v
		}
	}
}

func (r *reader) field() (int, int) {
	k := r.varint()
	return int(k >> 3), int(k & 7)
}

func (r *reader) chunk() []byte {
	n := int(r.varint())
	b := r.buf[r.at : r.at+n]
	r.at += n
	return b
}

func packed(b []byte) []uint64 {
	r := reader{buf: b}
	var out []uint64
	for r.at < len(b) {
		out = append(out, r.varint())
	}
	return out
}

func unzigzag(v uint64) int64 { return int64(v>>1) ^ -int64(v&1) }

func decode(t *testing.T, data []byte) decoded {
	t.Helper()
	tile := reader{buf: data}
	field, wire := tile.field()
	if field != 3 || wire != 2 {
		t.Fatalf("tile deveria começar pela camada, veio campo %d tipo %d", field, wire)
	}
	layer := reader{buf: tile.chunk()}
	var d decoded
	for layer.at < len(layer.buf) {
		field, wire := layer.field()
		switch {
		case field == 1:
			d.name = string(layer.chunk())
		case field == 2:
			f := reader{buf: layer.chunk()}
			var df decodedFeature
			for f.at < len(f.buf) {
				ff, fw := f.field()
				switch {
				case ff == 2:
					df.tags = packed(f.chunk())
				case ff == 3:
					df.typ = f.varint()
				case ff == 4:
					cmds := packed(f.chunk())
					var x, y int64
					for i := 0; i < len(cmds); {
						id, count := cmds[i]&7, int(cmds[i]>>3)
						i++
						if id == 1 {
							df.parts = append(df.parts, nil)
						}
						for c := 0; c < count; c++ {
							x += unzigzag(cmds[i])
							y += unzigzag(cmds[i+1])
							i += 2
							last := len(df.parts) - 1
							df.parts[last] = append(df.parts[last], [2]int64{x, y})
						}
					}
				case fw == 0:
					f.varint()
				default:
					f.chunk()
				}
			}
			d.features = append(d.features, df)
		case field == 3:
			d.keys = append(d.keys, string(layer.chunk()))
		case field == 4:
			v := reader{buf: layer.chunk()}
			vf, _ := v.field()
			if vf == 1 {
				d.values = append(d.values, string(v.chunk()))
			} else {
				d.values = append(d.values, v.varint() == 1)
			}
		case field == 5:
			d.extent = layer.varint()
		case wire == 0:
			layer.varint()
		default:
			layer.chunk()
		}
	}
	return d
}

func TestBlocoDoMarcoZeroDeSalvador(t *testing.T) {
	k := TileOf(-38.5108, -12.9714, 14)
	if k.X != 6439 || k.Y != 8787 {
		t.Fatalf("bloco z14 do Pelourinho: %+v", k)
	}
}

func TestSimplificaPontosAlinhados(t *testing.T) {
	line := []Point{{0, 0}, {10, 0.5}, {20, 0}, {30, 0.4}, {40, 0}, {40, 30}}
	got := Simplify(line, 2)
	want := []Point{{0, 0}, {40, 0}, {40, 30}}
	if len(got) != len(want) {
		t.Fatalf("simplificado %v, esperado %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("simplificado %v, esperado %v", got, want)
		}
	}
}

func TestRecorteQuebraALinhaQueSaiEVolta(t *testing.T) {
	line := []Point{{-50, 50}, {50, 50}, {150, 50}, {150, 80}, {50, 80}}
	parts := Clip(line, 0, 100)
	if len(parts) != 2 {
		t.Fatalf("esperado 2 pedaços dentro do bloco, vieram %d: %v", len(parts), parts)
	}
	if parts[0][0] != (Point{0, 50}) || parts[0][len(parts[0])-1] != (Point{100, 50}) {
		t.Fatalf("primeiro pedaço %v", parts[0])
	}
	if parts[1][0] != (Point{100, 80}) || parts[1][1] != (Point{50, 80}) {
		t.Fatalf("segundo pedaço %v", parts[1])
	}
	if got := Clip([]Point{{200, 200}, {300, 300}}, 0, 100); len(got) != 0 {
		t.Fatalf("linha fora do bloco gerou %v", got)
	}
}

func TestBlocoCodificadoVoltaIgualDecodificado(t *testing.T) {
	center := TileOf(-38.5108, -12.9714, 14)
	lines := []Line{
		{Points: []Point{{-38.5130, -12.9714}, {-38.5108, -12.9714}, {-38.5090, -12.9700}}, Class: "avenida", OneWay: true},
		{Points: []Point{{-38.5110, -12.9730}, {-38.5110, -12.9700}}, Class: "travessa"},
	}
	p := Build(lines)
	data, ok := p.Tile(center)
	if !ok || len(data) == 0 {
		t.Fatal("bloco com duas vias veio vazio")
	}
	d := decode(t, data)
	if d.name != "ruas" || d.extent != Extent || len(d.features) != 2 {
		t.Fatalf("camada %q extent %d com %d vias", d.name, d.extent, len(d.features))
	}
	if d.keys[0] != "class" || d.keys[1] != "oneway" {
		t.Fatalf("chaves %v", d.keys)
	}
	first := d.features[0]
	if first.typ != 2 || len(first.parts) != 1 || len(first.parts[0]) != 3 {
		t.Fatalf("primeira via: %+v", first)
	}
	if d.values[first.tags[1]] != "avenida" || d.values[first.tags[3]] != true {
		t.Fatalf("propriedades da primeira via: %v %v", d.values[first.tags[1]], d.values[first.tags[3]])
	}
	w := world(-38.5108, -12.9714, 14)
	got := first.parts[0][1]
	if math.Abs(float64(got[0])-(w.X-float64(center.X*Extent))) > 1 || math.Abs(float64(got[1])-(w.Y-float64(center.Y*Extent))) > 1 {
		t.Fatalf("ponto do meio em %v, esperado perto de (%.1f, %.1f)", got, w.X-float64(center.X*Extent), w.Y-float64(center.Y*Extent))
	}
	low, _ := p.Tile(TileOf(-38.5108, -12.9714, 11))
	if n := len(decode(t, low).features); n != 1 {
		t.Fatalf("travessa não deveria aparecer no zoom 11; vias no bloco: %d", n)
	}
	if data, ok := p.Tile(Key{14, center.X + 5, center.Y}); !ok || len(data) != 0 {
		t.Fatalf("bloco sem via deveria ser vazio, veio %d bytes", len(data))
	}
	if _, ok := p.Tile(Key{15, 0, 0}); ok {
		t.Fatal("zoom 15 está fora da pirâmide")
	}
}

func TestVersaoMudaComAMalha(t *testing.T) {
	a := Build([]Line{{Points: []Point{{-38.5, -12.9}, {-38.4, -12.9}}, Class: "rua"}})
	b := Build([]Line{{Points: []Point{{-38.5, -12.9}, {-38.4, -12.8}}, Class: "rua"}})
	if a.Version == b.Version || len(a.Version) != 12 {
		t.Fatalf("versões %q e %q", a.Version, b.Version)
	}
}
