package city

func arcs(n int, streets []Street) (start, to []int32) {
	start = make([]int32, n+1)
	for _, s := range streets {
		start[s.From+1]++
		if !s.OneWay {
			start[s.To+1]++
		}
	}
	for i := 1; i <= n; i++ {
		start[i] += start[i-1]
	}
	to = make([]int32, start[n])
	fill := make([]int32, n)
	copy(fill, start[:n])
	for _, s := range streets {
		to[fill[s.From]] = s.To
		fill[s.From]++
		if !s.OneWay {
			to[fill[s.To]] = s.From
			fill[s.To]++
		}
	}
	return start, to
}

type frame struct {
	v    int32
	next int32
}

func components(n int, streets []Street) (comp []int32, count int) {
	start, to := arcs(n, streets)
	index := make([]int32, n)
	low := make([]int32, n)
	onStack := make([]bool, n)
	comp = make([]int32, n)
	var stack []int32
	var counter int32
	visit := func(v int32) {
		counter++
		index[v], low[v] = counter, counter
		stack = append(stack, v)
		onStack[v] = true
	}
	for s := range n {
		if index[s] != 0 {
			continue
		}
		visit(int32(s))
		calls := []frame{{int32(s), start[s]}}
		for len(calls) > 0 {
			top := len(calls) - 1
			v := calls[top].v
			if e := calls[top].next; e < start[v+1] {
				calls[top].next++
				w := to[e]
				if index[w] == 0 {
					visit(w)
					calls = append(calls, frame{w, start[w]})
				} else if onStack[w] && index[w] < low[v] {
					low[v] = index[w]
				}
				continue
			}
			if low[v] == index[v] {
				for {
					w := stack[len(stack)-1]
					stack = stack[:len(stack)-1]
					onStack[w] = false
					comp[w] = int32(count)
					if w == v {
						break
					}
				}
				count++
			}
			calls = calls[:top]
			if top > 0 {
				if p := calls[top-1].v; low[v] < low[p] {
					low[p] = low[v]
				}
			}
		}
	}
	return comp, count
}

func (c *City) StronglyConnected() bool {
	_, count := components(len(c.Nodes), c.Streets)
	return count == 1
}
