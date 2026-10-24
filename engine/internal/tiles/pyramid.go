package tiles

import (
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"math"
	"sync"
)

const tolerance = 2.0

var fromZoom = map[string]int{"travessa": 12}

type Pyramid struct {
	lines   []Line
	buckets map[Key][]int32
	Version string
	mu      sync.RWMutex
	cache   map[Key][]byte
}

func Build(lines []Line) *Pyramid {
	p := &Pyramid{lines: make([]Line, len(lines)), buckets: map[Key][]int32{}, cache: map[Key][]byte{}}
	h := fnv.New64a()
	var scratch [8]byte
	for i, l := range lines {
		projected := make([]Point, len(l.Points))
		minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
		for j, pt := range l.Points {
			w := world(pt.X, pt.Y, MaxZoom)
			projected[j] = w
			minX, minY, maxX, maxY = math.Min(minX, w.X), math.Min(minY, w.Y), math.Max(maxX, w.X), math.Max(maxY, w.Y)
			binary.LittleEndian.PutUint64(scratch[:], math.Float64bits(pt.X+pt.Y))
			h.Write(scratch[:])
		}
		h.Write([]byte(l.Class))
		p.lines[i] = Line{Points: projected, Class: l.Class, OneWay: l.OneWay}
		for z := MinZoom; z <= MaxZoom; z++ {
			if z < fromZoom[l.Class] {
				continue
			}
			scale := math.Exp2(float64(z - MaxZoom))
			x0, x1 := int((minX*scale-Buffer)/Extent), int((maxX*scale+Buffer)/Extent)
			y0, y1 := int((minY*scale-Buffer)/Extent), int((maxY*scale+Buffer)/Extent)
			for x := x0; x <= x1; x++ {
				for y := y0; y <= y1; y++ {
					k := Key{z, x, y}
					p.buckets[k] = append(p.buckets[k], int32(i))
				}
			}
		}
	}
	p.Version = fmt.Sprintf("%x", h.Sum64())[:12]
	return p
}

func (p *Pyramid) Count() int { return len(p.buckets) }

func (p *Pyramid) Tile(k Key) ([]byte, bool) {
	if k.Z < MinZoom || k.Z > MaxZoom {
		return nil, false
	}
	p.mu.RLock()
	data, ok := p.cache[k]
	p.mu.RUnlock()
	if ok {
		return data, true
	}
	data = p.render(k)
	p.mu.Lock()
	p.cache[k] = data
	p.mu.Unlock()
	return data, true
}

func (p *Pyramid) Warm() {
	for k := range p.buckets {
		p.Tile(k)
	}
}

func (p *Pyramid) render(k Key) []byte {
	indices := p.buckets[k]
	if len(indices) == 0 {
		return nil
	}
	scale := math.Exp2(float64(k.Z - MaxZoom))
	ox, oy := float64(k.X*Extent), float64(k.Y*Extent)
	keys := []string{"class", "oneway"}
	var values []value
	index := map[value]uint32{}
	tag := func(v value) uint32 {
		if i, ok := index[v]; ok {
			return i
		}
		index[v] = uint32(len(values))
		values = append(values, v)
		return index[v]
	}
	features := make([]feature, 0, len(indices))
	for _, i := range indices {
		l := p.lines[i]
		local := make([]Point, len(l.Points))
		for j, pt := range l.Points {
			local[j] = Point{pt.X*scale - ox, pt.Y*scale - oy}
		}
		parts := quantize(Clip(Simplify(local, tolerance), -Buffer, Extent+Buffer))
		if len(parts) == 0 {
			continue
		}
		features = append(features, feature{
			tags:  []uint32{0, tag(value{s: l.Class}), 1, tag(value{b: l.OneWay, isBool: true})},
			parts: parts,
		})
	}
	return encode(features, keys, values)
}
