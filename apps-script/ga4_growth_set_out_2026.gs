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

/** Períodos usados em descobrirAssinatura(): julho (assinatura conhecida) vs setembro. */
const PERIODOS_ASSINATURA = [
  { nome: 'Jul/26', ini: '2026-07-01', fim: '2026-07-31' },
  { nome: 'Set/26 (01-30)', ini: '2026-09-01', fim: '2026-09-30' }
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

// ============================== PONTOS DE ENTRADA ==============================

function rodarOscarWeb()        { rodarBandeira_('Oscar Calçados (web)'); }
function rodarOscarApp()        { rodarBandeira_('Oscar Calçados (app)'); }
function rodarPaquetaEsportes() { rodarBandeira_('Paquetá Esportes (web)'); }
function rodarPaquetaCalcados() { rodarBandeira_('Paquetá Calçados (web)'); }
function rodarDiadora()         { rodarBandeira_('Diadora (web)'); }

function reiniciarFila() {
  PropertiesService.getDocumentProperties().deleteProperty('fila');
  SpreadsheetApp.getActive().toast('Fila reiniciada.');
}

/** Roda todas as bandeiras ativas. Se estourar o tempo, execute novamente: retoma de onde parou. */
function rodarTudo() {
  const inicio = Date.now();
  const props = PropertiesService.getDocumentProperties();
  let fila = props.getProperty('fila');
  fila = fila ? JSON.parse(fila) : BANDEIRAS.filter(b => b.ativo).map(b => b.nome);

  while (fila.length) {
    if (Date.now() - inicio > OPCOES.tempoMaxMs) {
      props.setProperty('fila', JSON.stringify(fila));
      SpreadsheetApp.getActive().toast('Tempo esgotado. Pendentes: ' + fila.join(', ') + '. Execute rodarTudo() de novo.', 'Growth', 10);
      return;
    }
    rodarBandeira_(fila[0]);
    fila.shift();
    props.setProperty('fila', JSON.stringify(fila));
  }
  props.deleteProperty('fila');
  SpreadsheetApp.getActive().toast('Concluído.', 'Growth', 5);
}

// ============================== NÚCLEO ==============================

function rodarBandeira_(nome) {
  const b = BANDEIRAS.find(x => x.nome === nome);
  if (!b) throw new Error('Bandeira não encontrada: ' + nome);
  if (!b.ativo) { SpreadsheetApp.getActive().toast(nome + ' inativa.'); return; }

  const consultas = montarConsultas_(b);
  executarConsultas_(b, consultas);

  const dados = {};   // aba -> { cab, linhas, nTexto }
  const log = [];
  consultas.forEach(c => {
    let linhas = [], status = 'OK', erro = '';
    if (c.resp) {
      linhas = converterLinhas_(b, c);
      const total = Number(c.resp.rowCount || linhas.length);
      if (total > linhas.length) { status = 'PARCIAL'; erro = 'rowCount=' + total + ' > retornadas=' + linhas.length; }
      if (c.usouFallback) { status = status === 'OK' ? 'OK (fallback sem sessions)' : status; }
    } else {
      status = 'ERRO'; erro = c.erro || 'sem resposta';
    }
    if (!dados[c.aba]) dados[c.aba] = { cab: cabecalho_(c), linhas: [], nTexto: 2 + c.dims.length };
    linhas.forEach(l => dados[c.aba].linhas.push(l));
    log.push([new Date(), b.nome, c.aba, c.periodo, status, linhas.length, String(erro).substring(0, 500)]);
  });

  Object.keys(dados).forEach(aba => substituirLinhas_(aba, dados[aba].cab, b.nome, dados[aba].linhas, dados[aba].nTexto));
  substituirLinhas_(ABA_LOG, CAB_LOG, b.nome, log.map(l => l.slice()), 0, 1);
  SpreadsheetApp.getActive().toast(b.nome + ' concluída (' + log.filter(l => l[4] === 'ERRO').length + ' erros).', 'Growth', 5);
}

function montarConsultas_(b) {
  const dev = b.dimDevice;
  const q = [];
  const porSessoes = [{ metric: { metricName: 'sessions' }, desc: true }];

  PERIODOS.filter(p => p.ativo).forEach(p => {
    const dr = [{ startDate: p.ini, endDate: p.fim }];
    q.push(consulta_(b, 'GA_KPIs',         p, [],                                 METRICAS_KPI, dr, null, true, porSessoes));
    q.push(consulta_(b, 'GA_Device',       p, [dev],                              METRICAS_KPI, dr, null, true, porSessoes));
    q.push(consulta_(b, 'GA_Canal_Device', p, ['sessionSourceMedium', dev],       METRICAS_KPI, dr, null, true, porSessoes));
    q.push(consulta_(b, 'GA_Campanha',     p, ['sessionSourceMedium', 'sessionCampaignName'], METRICAS_KPI, dr, null, true, porSessoes));
    q.push(consulta_(b, 'GA_Funil',        p, ['eventName', dev],                 METRICAS_FUNIL, dr, filtroEventos_(), false, null, ['eventCount', 'totalUsers']));
  });

  const pDiario = { nome: 'Diario ' + OPCOES.diarioIni + ' a ' + OPCOES.diarioFim, ini: OPCOES.diarioIni, fim: OPCOES.diarioFim };
  q.push(consulta_(b, 'GA_Diario', pDiario, ['date', dev], METRICAS_DIARIO,
    [{ startDate: pDiario.ini, endDate: pDiario.fim }], null, false, [{ dimension: { dimensionName: 'date' } }]));

  const pHist = { nome: 'Historico', ini: OPCOES.historicoIni, fim: OPCOES.historicoFim };
  const drH = [{ startDate: pHist.ini, endDate: pHist.fim }];
  q.push(consulta_(b, 'GA_Mensal_Canal', pHist, ['yearMonth', 'sessionSourceMedium'], METRICAS_KPI, drH, null, true,
    [{ dimension: { dimensionName: 'yearMonth' } }, { metric: { metricName: 'sessions' }, desc: true }]));
  q.push(consulta_(b, 'GA_Mensal_Funil', pHist, ['yearMonth', 'eventName', dev], METRICAS_FUNIL, drH, filtroEventos_(), false,
    [{ dimension: { dimensionName: 'yearMonth' } }], ['eventCount', 'totalUsers']));
  return q;
}

function filtroEventos_() {
  return { filter: { fieldName: 'eventName', inListFilter: { values: EVENTOS_FUNIL } } };
}

function consulta_(b, aba, p, dims, metrics, dateRanges, filtroExtra, derivar, orderBys, metricasFallback) {
  const req = {
    dateRanges: dateRanges,
    dimensions: dims.map(d => ({ name: d })),
    metrics: metrics.map(m => ({ name: m })),
    limit: String(OPCOES.limiteLinhas),
    keepEmptyRows: false
  };
  const filtro = montarFiltro_(b, filtroExtra);
  if (filtro) req.dimensionFilter = filtro;
  if (orderBys) req.orderBys = orderBys;
  return { aba: aba, periodo: p.nome, fim: p.fim, dims: dims, metrics: metrics, derivar: !!derivar, req: req, metricasFallback: metricasFallback || null };
}

/** Combina um filtro extra com a exclusão de tráfego inválido: NOT(AND(condições)). */
function montarFiltro_(b, extra) {
  const f = b.filtroInvalido;
  let exclusao = null;
  if (f && f.ativo && f.condicoes && f.condicoes.length) {
    exclusao = {
      notExpression: {
        andGroup: {
          expressions: f.condicoes.map(c => ({
            filter: {
              fieldName: c.campo,
              stringFilter: { matchType: c.tipo, value: c.valor, caseSensitive: false }
            }
          }))
        }
      }
    };
  }
  if (extra && exclusao) return { andGroup: { expressions: [extra, exclusao] } };
  return extra || exclusao || null;
}

// ============================== CHAMADAS À API ==============================

function executarConsultas_(b, consultas) {
  const prop = 'properties/' + b.propertyId;
  for (let i = 0; i < consultas.length; i += OPCOES.tamanhoLote) {
    const lote = consultas.slice(i, i + OPCOES.tamanhoLote);
    let resp = null;
    try {
      resp = comRetry_(() => AnalyticsData.Properties.batchRunReports({ requests: lote.map(c => c.req) }, prop));
    } catch (e) { resp = null; }   // um erro derruba o lote inteiro: refaz individualmente

    lote.forEach((c, k) => {
      if (resp && resp.reports && resp.reports[k]) { c.resp = resp.reports[k]; return; }
      try {
        c.resp = comRetry_(() => AnalyticsData.Properties.runReport(c.req, prop));
      } catch (e) {
        c.erro = e.message || String(e);
        if (c.metricasFallback) {   // ex.: 'sessions' incompatível com eventName
          try {
            const req2 = JSON.parse(JSON.stringify(c.req));
            req2.metrics = c.metricasFallback.map(m => ({ name: m }));
            c.resp = comRetry_(() => AnalyticsData.Properties.runReport(req2, prop));
            c.metricsUsadas = c.metricasFallback;
            c.usouFallback = true;
            c.erro = '';
          } catch (e2) { c.erro += ' | fallback: ' + (e2.message || e2); }
        }
      }
    });
  }
}

function comRetry_(fn) {
  let ultimo;
  for (let t = 0; t < OPCOES.tentativas; t++) {
    try { return fn(); } catch (e) {
      ultimo = e;
      const m = String(e.message || e);
      if (/quota|429|503|500|unavailable|exhausted|rate/i.test(m)) Utilities.sleep(1500 * Math.pow(2, t));
      else throw e;
    }
  }
  throw ultimo;
}

// ============================== CONVERSÃO E GRAVAÇÃO ==============================

function cabecalho_(c) {
  const cab = ['Bandeira', 'Periodo'];
  c.dims.forEach(d => cab.push(ROTULO_DIM[d] || d));
  c.metrics.forEach(m => cab.push(ROTULO_MET[m] || m));
  if (c.derivar) cab.push('CVR', 'TKM');
  cab.push('Obs');
  return cab;
}

function converterLinhas_(b, c) {
  const rows = c.resp.rows || [];
  const hdr = (c.resp.metricHeaders || []).map(h => h.name);
  return rows.map(r => {
    const dimVals = r.dimensionValues.map((d, i) => formatarDim_(c.dims[i], d.value));
    const mapa = {};
    hdr.forEach((n, i) => { mapa[n] = Number(r.metricValues[i].value); });
    const mets = c.metrics.map(m => (m in mapa ? mapa[m] : ''));
    const linha = [b.nome, c.periodo].concat(dimVals, mets);
    if (c.derivar) {
      const s = mapa.sessions, t = mapa.transactions, rec = mapa.purchaseRevenue;
      linha.push(s > 0 ? t / s : '', t > 0 ? rec / t : '');
    }
    linha.push(obs_(b, c, dimVals));
    return linha;
  });
}

function formatarDim_(nome, v) {
  if (nome === 'date' && v.length === 8) return v.substring(0, 4) + '-' + v.substring(4, 6) + '-' + v.substring(6, 8);
  return v;
}

function obs_(b, c, dimVals) {
  if (!b.avisoCompraDuplicada) return '';
  const msg = 'Compra duplicada no app desde 25/09: usar faturado';
  if (c.aba === 'GA_Diario') return dimVals[0] >= OPCOES.inicioDuplicacaoApp ? msg : '';
  if (c.aba === 'GA_Mensal_Canal' || c.aba === 'GA_Mensal_Funil') return dimVals[0] >= '202609' ? msg : '';
  return c.fim >= OPCOES.inicioDuplicacaoApp ? msg : '';
}

/** Remove as linhas da bandeira (coluna A, ou colunaChave) e acrescenta as novas. */
function substituirLinhas_(nomeAba, cab, bandeira, novas, nTexto, colunaChave) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(nomeAba) || ss.insertSheet(nomeAba);
  const k = colunaChave || 0;
  const n = cab.length;
  let manter = [];
  if (sh.getLastRow() > 1 && sh.getLastColumn() > 0) {
    manter = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
      .filter(r => r[k] !== bandeira && r[k] !== '');
  }
  const todas = manter.concat(novas).map(r => {
    const x = r.slice(0, n);
    while (x.length < n) x.push('');
    return x;
  });
  sh.clear();
  if (nTexto) sh.getRange(1, 1, Math.max(todas.length + 1, 2), nTexto).setNumberFormat('@');
  sh.getRange(1, 1, 1, n).setValues([cab]).setFontWeight('bold');
  if (todas.length) sh.getRange(2, 1, todas.length, n).setValues(todas);
  sh.setFrozenRows(1);
}

// ============================== VALIDAÇÃO E ASSINATURA ==============================

/** Confirma via Data API (getMetadata) que as dimensões e métricas do script existem na propriedade. */
function validarDimensoes() {
  const b = BANDEIRAS[0];
  const meta = AnalyticsData.Properties.getMetadata('properties/' + b.propertyId + '/metadata');
  const dims = {}, mets = {};
  meta.dimensions.forEach(d => { dims[d.apiName] = true; });
  meta.metrics.forEach(m => { mets[m.apiName] = true; });

  const usadasDim = ['deviceCategory', 'platform', 'sessionSourceMedium', 'sessionCampaignName', 'eventName', 'date', 'yearMonth', 'browserVersion', 'screenResolution'];
  const usadasMet = ['sessions', 'totalUsers', 'transactions', 'purchaseRevenue', 'eventCount', 'totalPurchasers'];
  const linhas = usadasDim.map(d => [new Date(), b.nome, 'metadata', 'dimensao ' + d, dims[d] ? 'OK' : 'NAO EXISTE', '', ''])
    .concat(usadasMet.map(m => [new Date(), b.nome, 'metadata', 'metrica ' + m, mets[m] ? 'OK' : 'NAO EXISTE', '', '']));
  substituirLinhas_(ABA_LOG, CAB_LOG, '__validacao__', [], 0, 1);
  const sh = SpreadsheetApp.getActive().getSheetByName(ABA_LOG);
  sh.getRange(sh.getLastRow() + 1, 1, linhas.length, 7).setValues(linhas);
  Logger.log(linhas.map(l => l[3] + ': ' + l[4]).join('\n'));
  SpreadsheetApp.getActive().toast('browserVersion: ' + (dims.browserVersion ? 'OK' : 'NAO EXISTE'), 'Validação', 8);
}

/**
 * Lista as combinações browserVersion x screenResolution do tráfego desktop + (direct) / (none) da Oscar web,
 * em julho e setembro, para confirmar se a assinatura de setembro é a mesma. Grava em GA_Assinatura.
 */
function descobrirAssinatura() {
  const b = BANDEIRAS[0];
  const prop = 'properties/' + b.propertyId;
  const dims = ['browserVersion', 'screenResolution', 'deviceCategory', 'sessionSourceMedium'];
  const filtro = { andGroup: { expressions: [
    { filter: { fieldName: 'deviceCategory', stringFilter: { matchType: 'EXACT', value: 'desktop' } } },
    { filter: { fieldName: 'sessionSourceMedium', stringFilter: { matchType: 'EXACT', value: '(direct) / (none)' } } }
  ] } };
  const cab = ['Bandeira', 'Periodo', 'Versao navegador', 'Resolucao', 'Device', 'Origem/Midia', 'Sessoes', 'Transacoes', 'Receita'];
  const linhas = [];
  PERIODOS_ASSINATURA.forEach(p => {
    const resp = comRetry_(() => AnalyticsData.Properties.runReport({
      dateRanges: [{ startDate: p.ini, endDate: p.fim }],
      dimensions: dims.map(d => ({ name: d })),
      metrics: ['sessions', 'transactions', 'purchaseRevenue'].map(m => ({ name: m })),
      dimensionFilter: filtro,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: '60'
    }, prop));
    (resp.rows || []).forEach(r => linhas.push([b.nome, p.nome]
      .concat(r.dimensionValues.map(d => d.value), r.metricValues.map(m => Number(m.value)))));
  });
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('GA_Assinatura') || ss.insertSheet('GA_Assinatura');
  sh.clear();
  sh.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold');
  if (linhas.length) {
    sh.getRange(2, 1, linhas.length, 6).setNumberFormat('@');
    sh.getRange(2, 1, linhas.length, cab.length).setValues(linhas);
  }
  sh.setFrozenRows(1);
}
