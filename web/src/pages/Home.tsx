import { useI18n } from '../i18n/useI18n'
import { GlobeBoundary } from '../components/GlobeBoundary'
import { StreakCard } from '../components/StreakCard'
import { Suspense, lazy } from 'react'

// Three.js só é baixado quando a abertura aparece.
const Globe = lazy(() => import('../components/Globe'))

const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 py-12">
      <h2 id={`${id}-title`} className="font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">
        {title}
      </h2>
      {lead ? <p className="mt-3 max-w-prose text-(--fg-muted)">{lead}</p> : null}
      <div className="mt-6">{children}</div>
    </section>
  )
}

export function Home() {
  const { t } = useI18n()
  const steps = [
    { title: t('step1Title'), body: t('step1Body') },
    { title: t('step2Title'), body: t('step2Body') },
    { title: t('step3Title'), body: t('step3Body') },
    { title: t('step4Title'), body: t('step4Body') },
    { title: t('step5Title'), body: t('step5Body') },
  ]
  const pillars = [
    { title: t('pillarOneTitle'), body: t('pillarOneBody') },
    { title: t('pillarTwoTitle'), body: t('pillarTwoBody') },
    { title: t('pillarThreeTitle'), body: t('pillarThreeBody') },
  ]
  const delivers = [t('deliverCalendar'), t('deliverAnomaly'), t('deliverKpi'), t('deliverMap'), t('deliverExport')]
  const status = [t('statusDone'), t('statusDoing'), t('statusNext')]

  return (
    <div id="top">
      {/* Abertura */}
      {/* Faixa de largura total: a nebulosa cobre a tela inteira, sem bordas visíveis. */}
      <section aria-labelledby="hero-title" className="relative left-1/2 w-screen -translate-x-1/2 overflow-hidden">
        <div aria-hidden="true" className="nebula absolute inset-0" />
        <div className="relative mx-auto flex max-w-[66rem] flex-col justify-center px-4 py-6 md:py-8">
        <div className="grid w-full items-center gap-10 md:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="font-mono text-xs tracking-wider text-(--accent-2) uppercase">{t('heroKicker')}</p>
            <h1 id="hero-title" className="mt-3 font-display text-[2rem] leading-[1.1] font-extrabold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              {t('tagline')}
            </h1>
            <p className="mt-5 max-w-prose text-lg text-(--fg-muted)">{t('heroLead')}</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a href="/painel" className="rounded-md bg-(--accent) px-5 py-2.5 text-sm font-bold text-(--bg) hover:opacity-90">
                {t('ctaDashboard')} →
              </a>
              <a href="#solution" className="rounded-md border border-(--line) px-4 py-2 text-sm font-semibold hover:border-(--accent)">
                {t('ctaSolution')}
              </a>
              <a href="#method" className="rounded-md border border-(--line) px-4 py-2 text-sm font-semibold hover:border-(--accent)">
                {t('ctaMethod')}
              </a>
            </div>
          </div>

          <div className="relative mx-auto aspect-square w-full max-w-[min(760px,88svh)]">
            <div className="absolute inset-0">
              <GlobeBoundary fallback={null}>
                <Suspense fallback={null}>
                  <Globe animated={!reducedMotion} label={t('globeLabel')} />
                </Suspense>
              </GlobeBoundary>
            </div>
          </div>
        </div>
        </div>
      </section>

      {/* Problema */}
      <Section id="problem" title={t('problemTitle')} lead={t('problemLead')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <article className="feature-card p-6 sm:p-7">
            <h3 className="font-mono text-xs tracking-wide text-(--accent-2) uppercase">{t('problemModisTitle')}</h3>
            <p className="mt-3 leading-relaxed text-(--fg-muted)">{t('problemModisBody')}</p>
          </article>
          <article className="feature-card p-6 sm:p-7">
            <h3 className="font-mono text-xs tracking-wide text-(--accent-2) uppercase">{t('problemViirsTitle')}</h3>
            <p className="mt-3 leading-relaxed text-(--fg-muted)">{t('problemViirsBody')}</p>
          </article>
        </div>
        <p className="mt-6 max-w-prose border-l-2 border-(--accent) pl-4 text-(--fg)">{t('problemJump')}</p>
      </Section>

      {/* Solução */}
      <Section id="solution" title={t('solutionTitle')} lead={t('solutionLead')}>
        <div className="grid gap-4 md:grid-cols-3">
          {pillars.map((p) => (
            <StreakCard key={p.title} streaks={false} className="p-6 sm:p-7">
              <h3 className="font-display text-xl font-semibold tracking-tight">{p.title}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-(--fg-muted)">{p.body}</p>
            </StreakCard>
          ))}
        </div>

        <h3 className="mt-10 font-display text-xl font-semibold">{t('deliverTitle')}</h3>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {delivers.map((d) => (
            <li key={d}>
              <StreakCard streaks={false} className="flex gap-3 px-4 py-3 text-sm">
                <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-(--accent)" />
                {d}
              </StreakCard>
            </li>
          ))}
        </ul>
      </Section>

      {/* Painel */}
      <section id="painel" aria-labelledby="painel-title" className="scroll-mt-20 py-12">
        <div className="feature-card flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div className="max-w-prose">
            <p className="font-mono text-xs tracking-wider text-(--accent-2) uppercase">{t('dashKicker')}</p>
            <h2 id="painel-title" className="mt-2 font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">
              {t('dashTitle')}
            </h2>
            <p className="mt-3 text-(--fg-muted)">{t('dashLead')}</p>
          </div>
          <a
            href="/painel"
            className="shrink-0 rounded-md bg-(--accent) px-5 py-2.5 text-center text-sm font-bold text-(--bg) hover:opacity-90"
          >
            {t('dashButton')} →
          </a>
        </div>
      </section>

      {/* Método */}
      <Section id="method" title={t('methodTitle')} lead={t('methodLead')}>
        <ol className="grid gap-3 md:grid-cols-5">
          {steps.map((s, i) => (
            <li key={s.title}>
              <StreakCard streaks={false} className="h-full p-5 sm:p-6">
                <p className="font-mono text-xs text-(--accent-2)">{String(i + 1).padStart(2, '0')}</p>
                <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">{s.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-(--fg-muted)">{s.body}</p>
              </StreakCard>
            </li>
          ))}
        </ol>
        <p className="mt-6 max-w-prose text-sm text-(--fg-muted)">{t('methodNote')}</p>
      </Section>

      {/* Estado */}
      <Section id="status" title={t('statusTitle')} lead={t('statusLead')}>
        <ul className="grid gap-3 sm:grid-cols-3">
          {status.map((s, i) => (
            <li key={s} className="feature-card p-5 text-sm sm:p-6">
              <span className="font-mono text-xs text-(--fg-muted)">{i === 0 ? '✓' : i === 1 ? '→' : '○'}</span>
              <p className="mt-2">{s}</p>
            </li>
          ))}
        </ul>
        <p className="mt-6 font-medium text-(--accent-2)">{t('statusNotOperational')}</p>
      </Section>

    </div>
  )
}
