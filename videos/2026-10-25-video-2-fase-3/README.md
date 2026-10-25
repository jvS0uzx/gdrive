# GDrive — vídeo 2 (fase 3: escala)

**Arquivo:** `gdrive-video-2.mp4` (1920×1080, 2 min 44 s, 14 MB), fora do git. Gravado em
25/10/2026 pelo roteiro `web/scripts/record-video-2.mjs`, na aba do Chromium, sem desktop. Os
trechos de tela carregando (o Grafana reinicia o app a cada navegação) são cortados na
conversão; cada troca de tela vira um corte seco.

**Fases cobertas:** 3. O vídeo 1 (fases 0 a 2) está em `../2026-10-24-video-1-fases-0-a-2/`.

## O que aparece

1. A central com os 60 entregadores do simulador.
2. O painel "GDrive — Escala" no Grafana enquanto 20 mil entregadores sintéticos entram em rampa,
   cada um com WebSocket real pelo nginx, divididos entre 4 instâncias do engine: posições por
   segundo chegando a 10 mil, conexões por instância e o fan-out.
3. A central com a cidade cheia: 20 mil pontos andando pelas ruas, com zoom.
4. O painel da fila do pool do Redis desde a primeira medição: o pico de 5.323 posições
   esperando conexão antes da gravação em lote, e a fila quase vazia depois.
5. O gráfico de antes e depois com 20 mil (`docs/escala/comparacao-20000.svg`).
6. Fecha em "Gdrive · fase 3 de 4 · próxima: copiloto de alertas".

As legendas com número saem dos CSV da matriz e do Prometheus na hora da gravação. O fan-out ao
vivo, no painel, fica pior que o da matriz: durante a gravação, o Chromium renderiza o mapa e
codifica o vídeo no mesmo notebook. A legenda diz isso, e os números do README são os da
matriz, medidos sem o navegador.

## Erros do caminho

- O despacho pegava os 50 entregadores mais próximos e só depois filtrava os livres: com a carga
  ligada, os despachos "aguardando" foram de 8 para 248 em 3 min.
- A primeira matriz reprovou 20 mil com 1, 2 e 4 engines, e mais instâncias pioravam. A primeira
  suspeita (o lock do retrato da central) estava errada: o atraso aparecia num caminho que nem
  passava pelo lock. Era a fila do pool de conexões do Redis.
- O nginx parava perto de 6 mil WebSockets (1024 conexões e 1024 descritores por processo); a
  faixa de portas efêmeras parava em 28 mil conexões para o mesmo destino.
- `docker compose run` recriava as dependências com uma réplica e derrubava a segunda instância
  do engine; as réplicas foram para o compose (`ENGINE_REPLICAS`).
- O 1.638 ms da primeira matriz era o teto do histograma, não o valor; os histogramas passaram
  a degraus de 1,5×.
- O mesmo ponto (1 engine, 20 mil) variou de 63 a 632 ms entre rodadas com o mesmo código: a
  variação da máquina é maior que a diferença entre lote de 20 e de 50 ms.
- Na gravação: a primeira legenda do fan-out pegou a rampa e mostrou "2.525 ms"; a fila do pool
  saiu como 750 com a consulta em passos de 15 s (o pico real foi 5.323).

## Texto do post

---

Última etapa planejada do GDrive pronta: escala.

A pergunta era simples: quantos motoboys o sistema aguenta, e colocar mais cópias do servidor
ajuda? Fiz um gerador que simula até 20 mil motoboys, cada um com conexão de verdade, mandando
a posição a cada 2 segundos. São 10 mil posições por segundo, tudo num notebook.

A primeira medição deu errado do jeito mais interessante: com 20 mil, nenhuma configuração
aguentava, e colocar mais cópias piorava. Meu primeiro palpite foi uma trava no código que monta
o mapa da central. Corrigi e nada mudou. O número que eu já tinha na mão mostrava que o atraso
aparecia num caminho que nem passava por ali. Quando olhei a fila de conexões com o Redis,
estava lá: cada posição fazia duas viagens até ele, e chegou a ter mais de 5 mil posições na
fila esperando, com o processador quase parado.

A correção foi juntar: cada cópia agrupa as posições e manda tudo a cada 20 ms numa viagem só.
O uso de processador caiu pela metade, e com duas ou quatro cópias o sistema aguenta os 20 mil.
Teve preço: com pouca gente, a posição demora um pouco mais pra aparecer, o tempo de esperar o
próximo grupo. E uma cópia sozinha com 20 mil ficou no limite; rodei o mesmo teste cinco vezes
e o resultado variou demais pra eu chamar de "aguenta".

A carga achou ainda um erro longe do que eu estava testando: o despacho olhava só os 50
motoboys mais perto da loja e só depois via quem estava livre. Com milhares de motoboys, os 50
mais perto podiam estar todos ocupados, e o pedido ficava esperando com gente livre a duas
quadras.

Próximo passo: um copiloto pros alertas da central, que sugere o que fazer e deixa a decisão
com quem opera.

#Go #Redis #Prometheus #Grafana #Docker
