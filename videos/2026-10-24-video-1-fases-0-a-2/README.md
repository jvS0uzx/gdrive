# GDrive — vídeo 1 (fases 0, 1 e 2)

**Arquivo:** `gdrive-video-1.mp4`, fora do git. 1920×1080, H.264, 30 fps, 3 min 23 s, 16 MB.
Gravado no Chromium, no Linux, com viewport de 1440×810 ampliado para 1080p (o texto fica
legível no celular), contra a pilha do `docker compose` com o simulador rodando:

```bash
docker compose up --build -d
cd web
CHROMIUM_PATH=/usr/bin/chromium BASE_URL=http://localhost:8085 node scripts/record-video-1.mjs ../videos/2026-10-24-video-1-fases-0-a-2/gdrive-video-1.mp4
```

**Fases cobertas:** 0, 1 e 2, conforme a regra de um vídeo a cada três fases. O próximo é só
da fase 3.

## O que aparece

1. Abertura na central ao vivo.
2. **Fase 0:** a rota mais rápida da Barra até Itapuã pelo roteador próprio, e a mesma rota
   com chuva, 40% mais lenta.
3. **Fase 1:** 60 entregadores e os pedidos despachados ao vivo; zoom nos cards, um por pedido
   na cor da etapa; a análise de um pedido com a rota escolhida contra as alternativas e o
   ranking do despacho (o mais perto em linha reta nem sempre é o mais rápido pelas ruas).
4. **Fase 2, loja:** operação na mão, pedido de teste, aceite com 10 min de preparo, o despacho
   procurando entregador durante o preparo, "pronto".
5. **Fase 2, entregador pelo celular:** fica online, recebe o pedido, o piloto automático anda
   pela rota real, a chegada sai do GPS, retirada só com o pedido pronto, entrega.
6. **Fase 2, central:** alertas de sem sinal e parado provocados pelo simulador, o alerta
   explicado na análise, a desatribuição devolvendo o pedido ao despacho, chuva e pico.
7. **Fase 2, histórico:** a entrega feita pelo celular, gravada no PostGIS, em replay contra a
   rota prevista.
8. Fecha em "GDrive · fases 0 a 2 de 4 · próxima: escala horizontal, com número".

As legendas são postas pelo roteiro de gravação, não pela aplicação. O roteiro provoca as
falhas pela api da simulação e devolve chuva, pico e lojas ao normal no fim.

## Erros do caminho (fase 2)

- Desvio de rota fantasma: alertas de 150 a 200 m que abriam e fechavam em segundos. A rota
  prevista nascia uns segundos depois e às vezes na rua do lado. Agora o desvio exige três
  posições seguidas fora.
- Todo reinício do simulador acende dezenas de alertas de sinal perdido juntos. Não é bug;
  ficou registrado como pergunta de operação.
- O card de pedido com alerta passava por cima do painel lateral (`z-index` sem contexto de
  empilhamento próprio no mapa).
- Ficar offline com uma oferta na mão segurava o pedido por 30 s.
- Na gravação: o `deviceScaleFactor` não amplia o vídeo do Playwright; a primeira versão saiu
  com a tela num canto do quadro 1080p. O roteiro agora grava no tamanho da viewport e amplia
  no ffmpeg.

## Texto do post

Terceira etapa do GDrive pronta, e com ela o vídeo mostrando tudo desde o começo: o mapa, os
pedidos e agora a operação.

Essa parte foi sobre o que acontece quando as coisas não saem como planejado. Fiz uma tela
pra loja aceitar, preparar e marcar pronto, uma tela de celular pro motoboy (com um piloto
automático que anda pela rota de verdade, porque eu não ia sair de moto pela cidade pra
testar) e, na central, alertas: motoboy sem sinal, parado, fora da rota, pedido atrasado e
pedido sem ninguém pra levar. Dá pra tirar o pedido de um motoboy e passar pra outro, ligar
chuva, simular horário de pico e até derrubar o sinal de um motoboy de propósito pra ver a
central reagir. E toda entrega fica gravada, com um replay do caminho feito contra o
caminho previsto.

O erro mais curioso dessa etapa: assim que liguei o alerta de "fora da rota", começaram a
aparecer alertas de motoboy que não tinha saído da rota nenhuma. Abriam e fechavam em
segundos. Fui olhar e a rota prevista era calculada uns segundos depois de o motoboy sair,
partindo da esquina mais próxima, que às vezes era a da rua do lado. As duas rotas andavam
separadas por um quarteirão e depois se juntavam, e bastava uma posição nesse trecho pra
disparar. Resolvi exigindo três posições seguidas fora da rota. GPS e rota calculada nunca
batem ponto a ponto; alerta que dispara com uma amostra só é ruído.

Outra que ficou na cabeça: toda vez que eu reiniciava o simulador, a central acendia uns 60
alertas de sinal perdido de uma vez. Não é bug, ninguém tava mandando posição mesmo. Deixei
assim, mas ficou a pergunta que toda operação de verdade precisa responder: o que fazer quando
todos os alertas disparam juntos?

Próxima e última etapa: escala. Colocar várias cópias do sistema rodando e medir, com número,
até onde ele aguenta.

#Go #Python #PostgreSQL #PostGIS #Redis #React
