/**
 * Growth Grupo Oscar | Extração GA4 (setembro e início de outubro/2026)
 *
 * Pré-requisitos:
 *  1. Apps Script > Serviços > adicionar "Google Analytics Data API" (identificador: AnalyticsData).
 *  2. Conta que executa precisa ter acesso de leitura às 5 propriedades GA4.
 *  3. Colar este arquivo inteiro em um projeto vinculado à planilha de destino.
 *
 * Funções principais:
 *  - validarDimensoes()      confirma via getMetadata que as dimensões/métricas existem (inclui browserVersion)
 *  - descobrirAssinatura()   lista browserVersion x screenResolution do tráfego desktop (direct) / (none), jul vs set
 *  - rodarTudo()             roda todas as bandeiras ativas, com fila retomável (limite de 6 min do Apps Script)
 *  - rodarOscarWeb(), rodarOscarApp(), rodarPaquetaEsportes(), rodarPaquetaCalcados(), rodarDiadora()
 *  - reiniciarFila()         zera a fila de rodarTudo()
 *
 * Cada execução por bandeira substitui apenas as linhas daquela bandeira em cada aba.
 */

// ============================== CONFIGURAÇÃO ==============================

/** Assinatura de tráfego inválido (Oscar web, julho/2026). Edite as condições se a de setembro for diferente. */
const FILTRO_INVALIDO_OSCAR_WEB = {
  ativo: true,
  condicoes: [
    { campo: 'deviceCategory',      tipo: 'EXACT',       valor: 'desktop' },
    { campo: 'sessionSourceMedium', tipo: 'EXACT',       valor: '(direct) / (none)' },
    { campo: 'browserVersion',      tipo: 'FULL_REGEXP', valor: '^(142\\.0\\.0\\.0|133\\.0\\.6943\\.141)$' },
    { campo: 'screenResolution',    tipo: 'FULL_REGEXP', valor: '^(1600x1600|1920x1080)$' }
  ]
};

/**
 * dimDevice: 'deviceCategory' (web) ou 'platform' (app).
 * filtroInvalido: objeto no formato acima ou null (sem exclusão).
 * avisoCompraDuplicada: marca na coluna Obs os dados a partir de 25/09 (evento de compra duplicado no app).
 */
const BANDEIRAS = [
  { nome: 'Oscar Calçados (web)',  propertyId: '260706521', dimDevice: 'deviceCategory', ativo: true, filtroInvalido: FILTRO_INVALIDO_OSCAR_WEB, avisoCompraDuplicada: false, funcao: 'rodarOscarWeb' },
  { nome: 'Oscar Calçados (app)',  propertyId: '316510550', dimDevice: 'platform',       ativo: true, filtroInvalido: null,                      avisoCompraDuplicada: true,  funcao: 'rodarOscarApp' },
  { nome: 'Paquetá Esportes (web)', propertyId: '412955216', dimDevice: 'deviceCategory', ativo: true, filtroInvalido: null,                      avisoCompraDuplicada: false, funcao: 'rodarPaquetaEsportes' },
  { nome: 'Paquetá Calçados (web)', propertyId: '321575998', dimDevice: 'deviceCategory', ativo: true, filtroInvalido: null,                      avisoCompraDuplicada: false, funcao: 'rodarPaquetaCalcados' },
  { nome: 'Diadora (web)',          propertyId: '321250920', dimDevice: 'deviceCategory', ativo: true, filtroInvalido: null,                      avisoCompraDuplicada: false, funcao: 'rodarDiadora' }
];

/** Períodos (YYYY-MM-DD). Referências de outubro alinhadas por dia da semana (qui a seg). */
const PERIODOS = [
  { nome: 'Set/26 (01-30)',              ini: '2026-09-01', fim: '2026-09-30', ativo: true },
  { nome: 'Ago/26 (01-30) ref',          ini: '2026-08-01', fim: '2026-08-30', ativo: true },
  { nome: 'Out/26 (01-05)',              ini: '2026-10-01', fim: '2026-10-05', ativo: true },
  { nome: 'Ref Out (03-07/09)',          ini: '2026-09-03', fim: '2026-09-07', ativo: true },
  { nome: 'Ref Out (24-28/09)',          ini: '2026-09-24', fim: '2026-09-28', ativo: true }
];

const EVENTOS_FUNIL = ['session_start', 'view_item', 'add_to_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase'];

const OPCOES = {
  diarioIni: '2026-08-01',
  diarioFim: '2026-10-05',
  historicoIni: '2026-05-01',
  historicoFim: '2026-10-05',
  inicioDuplicacaoApp: '2026-09-25',
  tamanhoLote: 5,
  limiteLinhas: 100000,
  tempoMaxMs: 4.5 * 60 * 1000,
  tentativas: 3
};

/** Períodos usados em descobrirAssinatura(): julho (assinatura conhecida), Ago 17-29, Set 08-17 e Out 03-05 (picos de desktop). */
const PERIODOS_ASSINATURA = [
  { nome: 'Jul/26',            ini: '2026-07-01', fim: '2026-07-31' },
  { nome: 'Ago 17-29 (pico)',  ini: '2026-08-17', fim: '2026-08-29' },
  { nome: 'Set 08-17 (pico)',  ini: '2026-09-08', fim: '2026-09-17' },
  { nome: 'Out 03-05 (pico)',  ini: '2026-10-03', fim: '2026-10-05' }
];

// ============================== RÓTULOS E ESQUEMA ==============================

const ROTULO_DIM = {
  deviceCategory: 'Device', platform: 'Device', sessionSourceMedium: 'Origem/Midia',
  sessionCampaignName: 'Campanha', eventName: 'Evento', date: 'Data', yearMonth: 'AnoMes',
  browserVersion: 'Versao navegador', screenResolution: 'Resolucao'
};
const ROTULO_MET = {
  sessions: 'Sessoes', totalUsers: 'Usuarios', transactions: 'Transacoes', purchaseRevenue: 'Receita',
  eventCount: 'Eventos', totalPurchasers: 'Compradores'
};
const METRICAS_KPI = ['sessions', 'totalUsers', 'transactions', 'purchaseRevenue'];
const METRICAS_FUNIL = ['sessions', 'totalUsers', 'eventCount'];
const METRICAS_DIARIO = ['sessions', 'transactions', 'totalPurchasers', 'purchaseRevenue'];
const ABA_LOG = 'GA_Log';
const CAB_LOG = ['Timestamp', 'Bandeira', 'Aba', 'Periodo', 'Status', 'Linhas', 'Erro'];

