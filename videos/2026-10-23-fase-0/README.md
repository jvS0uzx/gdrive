# GDrive — gravação da fase 0 (mapa e roteador)

**Arquivo:** `gdrive-fase-0.mp4`, fora do git. 1920×1080, H.264, 30 fps, 74 s, 5,2 MB.
Gravado no Chromium, no Linux, contra a pilha do `docker compose`:

```bash
docker compose up --build -d
cd web
CHROMIUM_PATH=/usr/bin/chromium BASE_URL=http://localhost:8085 pnpm video ../videos/2026-10-23-fase-0/gdrive-fase-0.mp4
```

**Fases cobertas:** 0. Gravação extra, pedida em 23/10/2026; o vídeo 1 (fases 0 a 2) continua
previsto para o fim da fase 2.

## O que aparece

1. Salvador inteira, importada do OpenStreetMap: 21.815 cruzamentos, 3.334 km de vias.
2. Barra → Itapuã: 23 min 13 s e 24,0 km, pela Av. Mário Leal Ferreira, Av. Paralela, Av.
   Jorge Amado e Av. Octávio Mangabeira. O ponto branco percorre a rota.
3. Chuva ligada: a mesma rota passa a 32 min 31 s.
4. Comércio → Rio Vermelho: 7 min 17 s e 7,3 km.
5. Clique no mar: o servidor responde "ponto fora da cidade" em vez de inventar rota.
6. Zoom em Nazaré: as ruas reais, com as setas de mão única.
7. Fecha em "GDrive · fase 0 de 4: mapa e roteador".

As legendas são postas pelo roteiro de gravação (`web/scripts/record-video.mjs`), não pela
aplicação. Os cliques saem de coordenadas reais, convertidas para a tela pela mesma projeção
do mapa.

## Erros do caminho

- A Overpass API respondeu 406 até o cliente mandar um User-Agent próprio.
- Mapa real não é fortemente conexo: ficam fora ilhas e pontas de mão única sem saída (2.845
  nós), sem inverter nenhuma mão única real.
- Em produção, o nginx servia o worker `.mjs` do MapLibre como `application/octet-stream`, e
  o teste ponta a ponta passava com o mapa em branco porque só olhava o painel.
- No Tailwind 4, o CSS da biblioteca de mapas, fora de camada, anulava o `absolute` do
  container e o mapa ficava com altura zero.
- Na gravação: a legenda no rodapé ficava em cima da Barra e engolia o clique; foi para o
  topo, com `pointer-events: none`.

## Texto do post

Comecei um projeto pessoal para estudar o algoritmo de despacho de um delivery: qual
entregador leva o pedido, por qual caminho e em quanto tempo. O nome é GDrive.

Fechei a fase 0 de 4: o mapa e o roteador.

O mapa é Salvador de verdade, importado do OpenStreetMap: 21.815 cruzamentos, 3.334 km de
vias, 7.139 ruas de mão única, 163 rotatórias e 1.573 restaurantes e lanchonetes reais, que
vão ser as lojas da simulação.

O roteador calcula a rota mais rápida, não a mais curta, usando a velocidade de cada via, e a
chuva deixa tudo 40% mais lento. É um A* escrito do zero em Go: uma rota entre dois pontos
aleatórios da cidade sai em 8 ms, sobre 156 mil nós. No vídeo, da Barra até Itapuã: 23
minutos e 24 km pela Bonocô, Paralela, Jorge Amado e orla.

Como provar que está certo? A* contra Dijkstra em 1.000 grafos aleatórios e em 400 pares de
pontos de Salvador, mão única respeitada em 200 rotas, e teste ponta a ponta no navegador.

O que o caminho ensinou:

→ Comecei gerando uma cidade a partir de uma semente, com centro, anel viário, radiais, rio
e rodovia. Funcionava e tinha testes bonitos, mas olhando o mapa não convencia ninguém.
Joguei fora e importei a cidade real. Código descartado também é decisão de engenharia.

→ Mapa real não é fortemente conexo: tem ilha, rua de mão única que termina num beco, erro
de mapeamento. A tentação é inverter a mão única para fechar a malha. Isso seria mentir
sobre a cidade. Fica só o maior pedaço em que se chega de qualquer lugar a qualquer lugar, e
2.845 nós saem.

→ A API pública do OpenStreetMap respondeu 406 até o cliente se identificar com um
User-Agent próprio. API gratuita tem etiqueta.

→ No front, o mapa ficou em branco em produção: o nginx entregava o worker .mjs do MapLibre
como application/octet-stream, e o navegador recusa módulo com esse tipo. O teste ponta a
ponta passava mesmo assim, porque só olhava o painel. Agora o painel só libera o clique
depois que a malha carregou de verdade, e conferi que, com o nginx antigo, o teste fica
vermelho. Teste que passa com a tela quebrada não testa nada.

Próxima fase: pedidos, despacho automático e entregadores andando por essas ruas.

Mapa: © colaboradores do OpenStreetMap.

Go · React · TypeScript · MapLibre · Docker · Playwright
