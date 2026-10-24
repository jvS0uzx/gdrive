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
};

const ACTOR_LABELS: Record<string, string> = {
  cliente: "cliente",
  loja: "loja",
  entregador: "entregador",
  despacho: "despacho",
  rastreio: "GPS",
  sistema: "sistema",
};

const STATUS_TONES: Record<string, string> = {
  aguardando_loja: "text-slate-300",
  em_preparo: "text-violet-400",
  a_caminho_da_loja: "text-yellow-300",
  na_loja: "text-orange-400",
  em_rota: "text-sky-400",
  no_cliente: "text-pink-400",
  entregue: "text-emerald-300",
  recusado: "text-target",
  cancelado: "text-target",
};

const STATUS_FILLS: Record<string, string> = {
  aguardando_loja: "bg-slate-300",
  em_preparo: "bg-violet-400",
  a_caminho_da_loja: "bg-yellow-300",
  na_loja: "bg-orange-400",
  em_rota: "bg-sky-400",
  no_cliente: "bg-pink-400",
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
  return STATUS_TONES[status] ?? "text-zinc-300";
}

export function statusFill(status: string): string {
  return STATUS_FILLS[status] ?? "bg-zinc-400";
}
