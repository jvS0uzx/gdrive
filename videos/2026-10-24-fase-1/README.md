# GDrive — gravação da fase 1 (núcleo do delivery)

**Arquivo:** `gdrive-fase-1.mp4`, fora do git. 1920×1080, H.264, 30 fps, 75 s.
Gravado no Chromium, no Linux, contra a pilha do `docker compose` com o simulador rodando:

```bash
docker compose up --build -d
cd web
CHROMIUM_PATH=/usr/bin/chromium BASE_URL=http://localhost:8085 node scripts/record-video-fase1.mjs ../videos/2026-10-24-fase-1/gdrive-fase-1.mp4
```

**Fases cobertas:** 1. Gravação extra, pedida em 24/10/2026; o vídeo 1 (fases 0 a 2) continua
previsto para o fim da fase 2.

## O que aparece

1. A central ao vivo: 60 entregadores andando por Salvador e um card `#id` por pedido ativo.
2. Zoom no aglomerado de pedidos: os cards mudando de cor conforme a etapa.
3. Clique num pedido: a rota escolhida desenhada contra a mais curta em metros e a que evita
   via expressa, com tempo, distância e diferença.
4. "Por que esse entregador": o ranking dos candidatos da oferta, com o tempo pelas ruas e a
   distância em linha reta. O roteiro escolhe um pedido em que o mais perto em linha reta não
   foi o mais rápido, para o destaque aparecer.
5. Rota prevista tracejada e rastro real por cima, com o desvio máximo entre as duas.
6. "Abrir acompanhamento": o que o cliente vê, com o entregador no mapa e a linha do tempo.
7. Fecha em "GDrive · fase 1 de 4: o núcleo do delivery".

As legendas são postas pelo roteiro de gravação, não pela aplicação.

## Erros do caminho

- O banco dizia "pronto" uns 2,5 s antes de aceitar conexão pela rede; na CI isso derrubava a
  migração.
- Na central, todo pedido atribuído aparecia como "Loja": um evento parcial apagava o nome.
- Nove pedidos parados por três motivos ao mesmo tempo: conexão morta no pool da api, o
  simulador desistindo na primeira falha e uma chegada presa sem confirmação no consumer group
  do Redis.
- O nginx guardava o IP antigo da api e do engine e dava 502 depois que eles eram recriados.
- A comparação de distância andada contra prevista dava a andada menor sem desvio nenhum:
  amostra espaçada corta curva. A medida virou o desvio de cada posição até a rota prevista.
- Na gravação: o zoom não acontecia porque a rolagem caía em cima de um card e não chegava ao
  mapa.

## Texto do post

Segunda etapa do GDrive pronta, aquele projeto pessoal que simula o despacho de um delivery
em Salvador.

Agora tem pedido de verdade acontecendo. O cliente pede de um dos restaurantes reais da
cidade, a loja aceita, e o sistema procura o entregador livre que chega mais rápido. Ele tem
30 segundos pra aceitar; se recusar ou deixar passar, vai pro próximo. Se não tiver ninguém
perto, o raio de busca vai abrindo de 2 até 6 km. Coloquei um simulador com 60 motoboys
andando pelas ruas de verdade e uma central que mostra tudo ao vivo, com um cartãozinho por
pedido que muda de cor a cada etapa.

Também quis conseguir provar que a escolha é boa, e não só confiar nela. Clicando num pedido,
a central mostra a rota escolhida do lado da mais curta em metros e de uma que evita via
expressa, a lista dos motoboys que o sistema avaliou e o caminho previsto contra o que ele
andou de fato. No vídeo aparece um caso legal: o motoboy mais perto em linha reta não foi o
escolhido, porque pelas ruas ele ia demorar mais.

O que mais deu trabalho não foi fazer funcionar, foi fazer continuar funcionando quando as
peças caem. Teve uma hora que nove pedidos simplesmente pararam no meio do caminho. Achei que
o simulador tinha reiniciado e perdido tudo, mas ele nem tinha reiniciado. Na real eram três
problemas juntos: a API tinha guardado conexões com o banco que já tinham morrido, o simulador
desistia de uma ação na primeira falha, e uma mensagem de "o motoboy chegou na loja" ficou
presa numa fila esperando uma confirmação que nunca vinha. Arrumei os três, e os pedidos
parados terminaram sozinhos.

Próxima etapa: painel da loja, entregador pelo celular, alertas e histórico das corridas.

#Go #Python #FastAPI #PostgreSQL #Redis
