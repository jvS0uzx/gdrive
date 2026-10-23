# despacho

Simulação de uma operação de delivery numa cidade gerada a partir de uma seed. Os
entregadores andam pela malha de ruas seguindo rotas de um roteador próprio, o despacho
oferece cada pedido ao entregador livre que chega mais rápido à loja, e cliente, loja e
central acompanham tudo ao vivo.

O objetivo é medir, com número, até onde o sistema escala na horizontal.

> **Estado:** planejamento. Nenhuma fase implementada ainda.

## Como funciona

- **Cidade:** gerada por seed, com avenidas, ruas de mão única e endereços de clientes, lojas
  e entregadores. Mesma seed, mesma cidade.
- **Roteamento:** rota mais rápida pela malha, da posição do entregador até a loja e da loja
  até o cliente. A* para a rota percorrida; Dijkstra de um para muitos para comparar
  candidatos no despacho.
- **Despacho:** a oferta vai para o entregador livre mais rápido de chegar à loja. Ele tem
  30 s para aceitar; se recusar ou não responder, passa para o próximo. Sem ninguém por
  perto, o raio de busca cresce de 2 para 4 e depois 6 km.
- **Rastreio ao vivo:** posição a cada 2 s. O sistema detecta sozinho a chegada na loja e no
  cliente, a perda de sinal, o entregador parado e o desvio de rota.
- **Telas:** central (mapa da cidade inteira e alertas), cliente (acompanhamento do pedido),
  loja, entregador (pelo celular) e simulador (rush, chuva, perda de sinal, modo carga).

## Componentes

| Parte | Tecnologia | Papel |
|---|---|---|
| `engine` | Go | WebSocket, posição, geofence, roteador. Roda em N instâncias |
| `citygen` | Go | Gera a cidade e valida que toda esquina alcança toda esquina |
| `sim` | Go | Entregadores e clientes simulados, um WebSocket real por entregador |
| `api` e `worker` | Python, FastAPI | Pedidos, máquina de estados, despacho, prazos |
| Estado | PostgreSQL + PostGIS | Fonte da verdade; outbox e jobs na mesma transação do pedido |
| Tempo real | Redis | Última posição, fan-out entre instâncias, Streams de eventos |
| Front | React, TypeScript, MapLibre, deck.gl | Mapa da malha gerada com milhares de pontos |
| Infra | Docker Compose, nginx, Prometheus, Grafana, k6 | Escala horizontal e medição |

## Fases

- [ ] **0. Cidade e roteador:** gerador de cidade e página que traça a rota mais rápida
  entre dois cliques.
- [ ] **1. Núcleo:** pedido de ponta a ponta, despacho com repasse e raio crescente,
  acompanhamento do cliente, mapa da central.
- [ ] **2. Operação:** painel da loja, entregador pelo celular, alertas, histórico com
  replay, rush e chuva.
- [ ] **3. Escala:** várias instâncias, modo carga, métricas e teste de carga.
