# GDrive — gravação da fase 0 (mapa e roteador)

**Arquivo:** `gdrive-fase-0.mp4` (1920×1080, 74 s), publicado no LinkedIn em 23/10/2026. O arquivo
e o roteiro de gravação eram do visual antigo e foram removidos em 24/10/2026, com a identidade
nova; a fase 0 aparece regravada no vídeo 1 (`../2026-10-24-video-1-fases-0-a-2/`).

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

Versão final, reescrita em tom de conversa a pedido do dono. O crédito do OpenStreetMap
aparece no próprio vídeo, no rodapé do painel.

Faz um tempo que venho mexendo, nas horas vagas, num projeto pessoal pra testar uma ideia:
entender como funciona por trás o despacho de um delivery. Quem pega o pedido, por onde vai e
quanto tempo leva. Chamei de GDrive.

Fechei agora a primeira das quatro etapas, que é o mapa e o cálculo de rota.

O mapa é Salvador mesmo, puxado do OpenStreetMap, com umas 21 mil esquinas e todas as mãos
únicas. O cálculo de rota eu escrevi do zero em Go. Ele busca o caminho mais rápido, e não o
mais curto, levando em conta a velocidade de cada via. Também coloquei um botão de chuva, que
deixa tudo mais lento. No vídeo tem uma rota da Barra até Itapuã que deu 23 minutos pela
Bonocô, Paralela e orla, que é mais ou menos o caminho que eu faria.

Algumas coisas que deram trabalho:

No começo eu tava gerando uma cidade fictícia, com centro, anel viário, rio, tudo.
Funcionava, mas olhando o mapa não parecia cidade nenhuma. Acabei jogando fora e indo pro
mapa real. Doeu, mas valeu.

O mapa real tem ilha, rua de mão única que dá num beco, erro de mapeamento... Em vez de
"consertar" a mão única pra fechar a malha, deixei de fora os pedaços que não se conectam com
o resto. Prefiro perder uns pontos a inventar rua.

E teve um que me fez perder um bom tempo: subi tudo no Docker e o mapa aparecia em branco,
mas os testes passavam. O nginx tava mandando um arquivo do mapa com o tipo errado e o
navegador recusava. O teste só conferia o painel, então ajustei pra ele esperar o mapa
carregar de verdade.

Próximo passo é colocar pedidos e motoboys andando por essas ruas. Vou postando aqui conforme
for andando.

#Go #React #TypeScript #MapLibre
