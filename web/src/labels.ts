export const ACTIVE_STATUSES = ["aguardando_loja", "em_preparo", "a_caminho_da_loja", "na_loja", "em_rota", "no_cliente"];

const STATUS_LABELS: Record<string, string> = {
  aguardando_loja: "Aguardando a loja",
  em_preparo: "Em preparo",
  a_caminho_da_loja: "Entregador a caminho da loja",
  na_loja: "Entregador na loja",
  em_rota: "A caminho de você",
  no_cliente: "Entregador chegou",
  entregue: "Entregue",
  recusado: "Recusado pela loja",
  cancelado: "Cancelado",
};

const EVENT_LABELS: Record<string, string> = {
  pedido_criado: "Pedido feito",
  pedido_aceito_pela_loja: "Loja aceitou o pedido",
  oferta_enviada: "Pedido oferecido a um entregador",
  oferta_recusada: "Entregador recusou a oferta",
  oferta_expirada: "Oferta ao entregador expirou",
  entregador_atribuido: "Entregador aceitou a entrega",
  entregador_desatribuido: "Entregador liberado da entrega",
  entregador_chegou_na_loja: "Entregador chegou na loja",
  pedido_pronto: "Pedido pronto na loja",
  pedido_coletado: "Entregador retirou o pedido",
  entregador_chegou_no_cliente: "Entregador chegou ao endereço",
  pedido_entregue: "Pedido entregue",
  pedido_cancelado: "Pedido cancelado",
  pedido_recusado_pela_loja: "Loja recusou o pedido",
  pedido_expirado_na_loja: "Loja não respondeu a tempo",
  pedido_sem_entregador: "Ainda sem entregador disponível",
  pedido_atrasado: "Pedido passou do horário prometido",
  sinal_perdido: "Entregador ficou sem sinal",
  entregador_parado: "Entregador parado",
  desvio_de_rota: "Entregador saiu da rota prevista",
  alerta_resolvido: "Alerta resolvido",
};

const ALERT_LABELS: Record<string, string> = {
  sinal_perdido: "Sem sinal",
  parado: "Parado",
  desvio: "Fora da rota",
  atraso: "Atrasado",
  sem_entregador: "Sem entregador",
};

const ALERT_HINTS: Record<string, string> = {
  sinal_perdido: "O entregador parou de mandar posição.",
  parado: "O entregador não sai do lugar a caminho do destino.",
  desvio: "O entregador está longe da rota prevista.",
  atraso: "O pedido passou do horário prometido ao cliente.",
  sem_entregador: "Nenhum entregador livre aceitou a corrida até 6 km.",
};

export const ALERT_KINDS = ["sinal_perdido", "parado", "desvio", "sem_entregador", "atraso"] as const;

const ACTOR_LABELS: Record<string, string> = {
  cliente: "cliente",
  loja: "loja",
  entregador: "entregador",
  despacho: "despacho",
  rastreio: "GPS",
  sistema: "sistema",
  central: "central",
};

const STATUS_TONES: Record<string, string> = {
  aguardando_loja: "text-[#c5d2dd]",
  em_preparo: "text-[#a993e6]",
  a_caminho_da_loja: "text-[#e3c45c]",
  na_loja: "text-[#e8935c]",
  em_rota: "text-[#4cc38a]",
  no_cliente: "text-[#e58ab8]",
  entregue: "text-origin",
  recusado: "text-target",
  cancelado: "text-target",
};

const STATUS_FILLS: Record<string, string> = {
  aguardando_loja: "bg-[#c5d2dd]",
  em_preparo: "bg-[#a993e6]",
  a_caminho_da_loja: "bg-[#e3c45c]",
  na_loja: "bg-[#e8935c]",
  em_rota: "bg-[#4cc38a]",
  no_cliente: "bg-[#e58ab8]",
};

const readable = (code: string) => code.replaceAll("_", " ");

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? readable(status);
}

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? readable(type);
}

export function actorLabel(actor: string): string {
  return ACTOR_LABELS[actor] ?? actor;
}

export function statusTone(status: string): string {
  return STATUS_TONES[status] ?? "text-muted";
}

export function statusFill(status: string): string {
  return STATUS_FILLS[status] ?? "bg-muted";
}

export function alertLabel(kind: string): string {
  return ALERT_LABELS[kind] ?? readable(kind);
}

export function alertHint(kind: string): string {
  return ALERT_HINTS[kind] ?? "";
}
