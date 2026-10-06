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
 * Lista as combinações browserVersion x screenResolution x sistema x país do tráfego desktop com origem
 * (direct) / (none) ou (not set), em cada período, para fechar a assinatura de tráfego inválido.
 * Grava em GA_Assinatura (substitui só as linhas da bandeira). Use o atalho da bandeira desejada.
 */
function descobrirAssinatura() { descobrirAssinatura_('Oscar Calçados (web)', PERIODOS_ASSINATURA); }
function descobrirAssinaturaEsportes() {
  descobrirAssinatura_('Paquetá Esportes (web)', [
    { nome: 'Ago/26 (01-30)', ini: '2026-08-01', fim: '2026-08-30' },
    { nome: 'Set/26 (01-30)', ini: '2026-09-01', fim: '2026-09-30' },
    { nome: 'Out/26 (01-05)', ini: '2026-10-01', fim: '2026-10-05' }
  ]);
}

function descobrirAssinatura_(nomeBandeira, periodos) {
  const b = BANDEIRAS.find(x => x.nome === nomeBandeira);
  const prop = 'properties/' + b.propertyId;
  const dims = ['browserVersion', 'screenResolution', 'operatingSystem', 'country', 'sessionSourceMedium'];
  const filtro = { andGroup: { expressions: [
    { filter: { fieldName: 'deviceCategory', stringFilter: { matchType: 'EXACT', value: 'desktop' } } },
    { filter: { fieldName: 'sessionSourceMedium', inListFilter: { values: ['(direct) / (none)', '(not set)'] } } }
  ] } };
  const cab = ['Bandeira', 'Periodo', 'Versao navegador', 'Resolucao', 'Sistema', 'Pais', 'Origem/Midia', 'Sessoes', 'Transacoes', 'Receita'];
  const linhas = [];
  periodos.forEach(p => {
    const resp = comRetry_(() => AnalyticsData.Properties.runReport({
      dateRanges: [{ startDate: p.ini, endDate: p.fim }],
      dimensions: dims.map(d => ({ name: d })),
      metrics: ['sessions', 'transactions', 'purchaseRevenue'].map(m => ({ name: m })),
      dimensionFilter: filtro,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: '40'
    }, prop));
    (resp.rows || []).forEach(r => linhas.push([b.nome, p.nome]
      .concat(r.dimensionValues.map(d => d.value), r.metricValues.map(m => Number(m.value)))));
  });
  substituirLinhas_('GA_Assinatura', cab, b.nome, linhas, 7);
}
