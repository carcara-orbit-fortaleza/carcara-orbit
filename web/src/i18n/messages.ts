// Dicionários de tradução. O português é a referência: toda chave nova entra aqui primeiro.
export const messages = {
  'pt-BR': {
    appName: 'Carcará Orbit',
    tagline: 'Vinte anos de fogo. Uma leitura.',
    language: 'Idioma',
    languagePt: 'Português',
    languageEn: 'English',
    starfieldOn: 'Ativar fundo estelar',
    starfieldOff: 'Desativar fundo estelar',

    navProblem: 'Problema',
    navSolution: 'Solução',
    navMethod: 'Método',
    navStatus: 'Estado',

    globeLabel: 'Globo ilustrativo com focos de calor sobre o Brasil. Imagem decorativa.',
    heroKicker: 'Calendário de atividade de queimadas',
    heroLead:
      'Harmonizamos mais de duas décadas de focos de calor do MODIS e do VIIRS, da NASA, em uma série única e comparável. Assim, um gestor consegue ver em um minuto se este mês está fora do normal para a sua região.',
    ctaSolution: 'Ver a solução',
    ctaMethod: 'Ver o método',

    problemTitle: 'Dois satélites, duas réguas',
    problemLead:
      'O histórico de focos vem de dois sensores que não se comparam diretamente. Sem tratamento, a série parece mudar sem que o fogo tenha mudado.',
    problemModisTitle: 'MODIS (Terra e Aqua)',
    problemModisBody: 'Desde 2000. Resolução de 1 km. Está chegando ao fim da vida útil.',
    problemViirsTitle: 'VIIRS (SNPP, NOAA-20, NOAA-21)',
    problemViirsBody: 'Desde 2012. Resolução de 375 m. Detecta mais pixels e tem sensibilidade diferente.',
    problemJump:
      'Quando o VIIRS entra, a contagem sobe. Quando o MODIS sai, a série quebra. O gestor não consegue separar mudança no fogo de mudança no instrumento.',

    solutionTitle: 'Uma série comparável, com incerteza visível',
    solutionLead:
      'O Carcará Orbit transforma os dois sensores em uma leitura única. A origem do dado continua disponível, mas não atrapalha a leitura.',
    pillarOneTitle: 'Harmonização explícita',
    pillarOneBody:
      'Grade de 0,1°, contagem por cluster e calibração na janela 2012–2025, por bioma e por mês.',
    pillarTwoTitle: 'Incerteza à vista',
    pillarTwoBody:
      'Fator de calibração, janela de sobreposição e confiança aparecem na interface, não escondidos em nota de rodapé.',
    pillarThreeTitle: 'Dados para levar',
    pillarThreeBody:
      'Calendário, anomalias e focos exportados em CSV com metadados e versão do método.',

    deliverTitle: 'O que o gestor vê',
    deliverCalendar: 'Calendário ano × mês, de 2000 a 2026, com escala de cores acessível.',
    deliverAnomaly: 'Anomalia do mês em relação à média de 2003–2025.',
    deliverKpi: 'Focos do ano parcial, pico histórico e tendência.',
    deliverMap: 'Mapa dos focos recentes sobre a região escolhida.',
    deliverExport: 'Exportação em CSV, com método e versão.',

    methodTitle: 'Como a série é construída',
    methodLead: 'Cinco etapas, do dado bruto ao calendário.',
    step1Title: 'Ingerir',
    step1Body: 'Focos do FIRMS: MODIS C6.1 e VIIRS 375 m, de NOAA-20 e NOAA-21.',
    step2Title: 'Limpar',
    step2Body: 'Remove baixa confiança, nuvens, bordas e duplicatas da mesma passagem.',
    step3Title: 'Agregar',
    step3Body: 'Grade de 0,1° e contagem por cluster, não por pixel.',
    step4Title: 'Calibrar',
    step4Body: 'Fator f = mediana(N_VIIRS / N_MODIS) na janela 2012–2025, por bioma e mês.',
    step5Title: 'Harmonizar',
    step5Body: 'N_h = N_obs × f, com incerteza declarada e versão do método.',
    methodNote:
      'A série é ancorada no MODIS porque ele cobre 2000–2011 sozinho. Os fatores ainda precisam de validação com especialistas.',

    statusTitle: 'Onde estamos',
    statusLead:
      'Protótipo funcional com dados sintéticos para demonstração. A ingestão do FIRMS real está em desenvolvimento.',
    statusDone: 'Protótipo com calendário, anomalias e mapa, usando dados sintéticos.',
    statusDoing: 'Ingestão FIRMS real e pipeline de harmonização.',
    statusNext: 'Validação dos fatores com especialistas e testes com usuários.',
    statusNotOperational:
      'Não use os números desta versão para decisão operacional.',

    teamTitle: 'Equipe',
    teamBody: 'Carcará Orbit: produto e dados, front-end, visualização e mapas, e fullstack e QA.',

    mockNotice:
      'Dados sintéticos para demonstração. Não use para decisão operacional.',
    notAffiliated: 'Carcará Orbit não é oficial nem endossado pela NASA.',
    dataCredit: 'Fonte prevista dos dados: NASA FIRMS (MODIS C6.1 e VIIRS).',
    modelCredit: 'Modelo 3D da Terra "Earth" por Akshat (Sketchfab), licença CC Attribution.',
    satelliteCredit: 'Modelo 3D do satélite "Simple Satellite Low Poly Free" por DjalalxJay (Sketchfab), CC BY 4.0.',
    globeCaptionLoading: 'Carregando focos…',
    globeCaptionReal: 'Focos reais FIRMS: {shown} na amostra de {total} no Brasil.',
    globeCaptionDemo: 'Demonstração: focos sintéticos, API não conectada.',

    // Chaves usadas pelo calendário e pelo gráfico anual (para a tela de análise).
    regionLabel: 'Região',
    kpiYear: 'Focos em {year} (jan–out)',
    kpiPeak: 'Pico histórico (ano completo)',
    kpiPeakValue: '{year}: {total} focos',
    calendarTitle: 'Calendário de focos por ano e mês',
    calendarCaption: 'Número de focos harmonizados por mês. Quanto mais claro, mais focos.',
    year: 'Ano',
    scale: 'Escala',
    scaleLow: 'menos',
    scaleHigh: 'mais',
    noData: 'sem dado',
    partial: 'parcial',
    cellLabel: '{month} {year}: {count} focos',
    annualTitle: 'Total anual de focos',
    annualAxis: 'Focos',
    noDataTitle: 'Dados ainda não conectados',
    noDataBody:
      'Os focos virão da API, quando a ingestão FIRMS (DEV-01) e a integração do front (DEV-08) estiverem prontas.',
  },
  en: {
    appName: 'Carcará Orbit',
    tagline: 'Twenty years of fire. One reading.',
    language: 'Language',
    languagePt: 'Português',
    languageEn: 'English',
    starfieldOn: 'Turn on starfield',
    starfieldOff: 'Turn off starfield',

    navProblem: 'Problem',
    navSolution: 'Solution',
    navMethod: 'Method',
    navStatus: 'Status',

    globeLabel: 'Illustrative globe with hotspots over Brazil. Decorative image.',
    heroKicker: 'Fire activity calendar',
    heroLead:
      'We harmonize more than two decades of NASA MODIS and VIIRS fire hotspots into one comparable series. In a minute, a manager can see whether this month is outside the normal range for their region.',
    ctaSolution: 'See the solution',
    ctaMethod: 'See the method',

    problemTitle: 'Two satellites, two yardsticks',
    problemLead:
      'The hotspot record comes from two sensors that cannot be compared directly. Without treatment, the series seems to change even when the fire did not.',
    problemModisTitle: 'MODIS (Terra and Aqua)',
    problemModisBody: 'Since 2000. 1 km resolution. Approaching the end of its operational life.',
    problemViirsTitle: 'VIIRS (SNPP, NOAA-20, NOAA-21)',
    problemViirsBody: 'Since 2012. 375 m resolution. Detects more pixels with different sensitivity.',
    problemJump:
      'When VIIRS enters, the count rises. When MODIS leaves, the series breaks. A manager cannot separate a change in fire from a change in the instrument.',

    solutionTitle: 'One comparable series, with visible uncertainty',
    solutionLead:
      'Carcará Orbit turns the two sensors into a single reading. The origin of each record stays available, without getting in the way.',
    pillarOneTitle: 'Explicit harmonization',
    pillarOneBody:
      'A 0.1° grid, cluster-based counting and calibration over 2012–2025, by biome and month.',
    pillarTwoTitle: 'Uncertainty in view',
    pillarTwoBody:
      'The calibration factor, the overlap window and the confidence appear in the interface, not in a footnote.',
    pillarThreeTitle: 'Data to take away',
    pillarThreeBody:
      'Calendar, anomalies and hotspots exported as CSV with metadata and method version.',

    deliverTitle: 'What the manager sees',
    deliverCalendar: 'Year × month calendar from 2000 to 2026, with an accessible color scale.',
    deliverAnomaly: 'Monthly anomaly against the 2003–2025 average.',
    deliverKpi: 'Partial-year hotspots, historical peak and trend.',
    deliverMap: 'Map of recent hotspots over the chosen region.',
    deliverExport: 'CSV export with method and version.',

    methodTitle: 'How the series is built',
    methodLead: 'Five steps, from raw data to the calendar.',
    step1Title: 'Ingest',
    step1Body: 'FIRMS hotspots: MODIS C6.1 and VIIRS 375 m from NOAA-20 and NOAA-21.',
    step2Title: 'Clean',
    step2Body: 'Removes low confidence, clouds, edges and duplicates from the same overpass.',
    step3Title: 'Aggregate',
    step3Body: '0.1° grid and cluster-based counting, not pixel-based.',
    step4Title: 'Calibrate',
    step4Body: 'Factor f = median(N_VIIRS / N_MODIS) over 2012–2025, by biome and month.',
    step5Title: 'Harmonize',
    step5Body: 'N_h = N_obs × f, with declared uncertainty and method version.',
    methodNote:
      'The series is anchored on MODIS because it covers 2000–2011 on its own. The factors still need validation with experts.',

    statusTitle: 'Where we are',
    statusLead:
      'A working prototype with synthetic data for demonstration. The real FIRMS ingestion is in development.',
    statusDone: 'Prototype with calendar, anomalies and map, using synthetic data.',
    statusDoing: 'Real FIRMS ingestion and the harmonization pipeline.',
    statusNext: 'Expert validation of the factors and user testing.',
    statusNotOperational: 'Do not use the numbers in this version for operational decisions.',

    teamTitle: 'Team',
    teamBody: 'Carcará Orbit: product and data, front-end, visualization and maps, and fullstack and QA.',

    mockNotice: 'Synthetic data for demonstration only. Do not use for operational decisions.',
    notAffiliated: 'Carcará Orbit is not an official product and is not endorsed by NASA.',
    dataCredit: 'Planned data source: NASA FIRMS (MODIS C6.1 and VIIRS).',
    modelCredit: '3D Earth model "Earth" by Akshat (Sketchfab), CC Attribution license.',
    satelliteCredit: '3D satellite model "Simple Satellite Low Poly Free" by DjalalxJay (Sketchfab), CC BY 4.0.',
    globeCaptionLoading: 'Loading hotspots…',
    globeCaptionReal: 'Real FIRMS hotspots: {shown} sampled out of {total} in Brazil.',
    globeCaptionDemo: 'Demo: synthetic hotspots, API not connected.',

    regionLabel: 'Region',
    kpiYear: 'Hotspots in {year} (Jan–Oct)',
    kpiPeak: 'Historical peak (complete year)',
    kpiPeakValue: '{year}: {total} hotspots',
    calendarTitle: 'Hotspot calendar by year and month',
    calendarCaption: 'Number of harmonized hotspots per month. Lighter cells mean more hotspots.',
    year: 'Year',
    scale: 'Scale',
    scaleLow: 'fewer',
    scaleHigh: 'more',
    noData: 'no data',
    partial: 'partial',
    cellLabel: '{month} {year}: {count} hotspots',
    annualTitle: 'Annual hotspot total',
    annualAxis: 'Hotspots',
    noDataTitle: 'Data not connected yet',
    noDataBody:
      'Hotspots will come from the API, once the FIRMS ingestion (DEV-01) and the front integration (DEV-08) are ready.',
  },
} as const

export type Locale = keyof typeof messages
export type MessageKey = keyof (typeof messages)['pt-BR']

export const LOCALES: Locale[] = ['pt-BR', 'en']
