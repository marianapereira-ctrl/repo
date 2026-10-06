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

