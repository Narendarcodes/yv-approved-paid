/**
 * First-visit guided tour: the steps for each role and a small state machine.
 * Pure (no React, no DOM) so it runs under node --test; components/Tour.tsx
 * draws it. Anchors are CSS selectors on real UI: [data-tour=...] on the
 * shell (nav items, avatar) and existing data-testids on the deal page.
 */

export interface TourStep {
  id: string
  /** CSS selector of the element the step points at. */
  target: string
  /** Where the anchor lives. When the anchor is missing the tour goes here and waits. */
  route?: string
  /** Shown instead when the target exists but has no box, e.g. a sidebar item on a phone: the menu button. */
  fallback?: string
  title: string
  /** One short sentence, sentence case. */
  body: string
}

export type TourStatus = 'idle' | 'running' | 'done'

export interface TourState {
  status: TourStatus
  index: number
  /** Direction of the last move, so a missing anchor skips the same way. */
  dir: 1 | -1
  count: number
}

export type TourAction =
  | { type: 'start'; count: number }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'skip' }
  /** The current step's anchor never appeared: move on in the last direction. */
  | { type: 'missing' }

export const initialTour: TourState = { status: 'idle', index: 0, dir: 1, count: 0 }

export function tourReducer(s: TourState, a: TourAction): TourState {
  switch (a.type) {
    case 'start':
      return a.count > 0
        ? { status: 'running', index: 0, dir: 1, count: a.count }
        : { ...initialTour, status: 'done' }
    case 'next':
      if (s.status !== 'running') return s
      return s.index + 1 >= s.count
        ? { ...s, status: 'done' }
        : { ...s, index: s.index + 1, dir: 1 }
    case 'back':
      if (s.status !== 'running' || s.index === 0) return s
      return { ...s, index: s.index - 1, dir: -1 }
    case 'skip':
      return s.status === 'running' ? { ...s, status: 'done' } : s
    case 'missing': {
      if (s.status !== 'running') return s
      const i = s.index + s.dir
      if (i >= s.count) return { ...s, status: 'done' }
      // nothing before the first step: carry on forward instead
      if (i < 0) return s.count > 1 ? { ...s, index: 1, dir: 1 } : { ...s, status: 'done' }
      return { ...s, index: i }
    }
  }
}

/** "Step 2 of 8" */
export const stepLabel = (s: TourState) => `Step ${s.index + 1} of ${s.count}`

/** Seen flag, one per user. */
export const seenKey = (userId: string) => `yv.tour.seen.${userId}`

/** True when route (a path with an optional ?query) is the current location. */
export function atRoute(route: string, pathname: string, search: string): boolean {
  const [path, query = ''] = route.split('?')
  if (path !== pathname) return false
  const want = new URLSearchParams(query)
  const have = new URLSearchParams(search)
  for (const [k, v] of want) if (have.get(k) !== v) return false
  return true
}

const nav = (to: string) => `[data-tour="nav-${to}"]`
const NAV_MENU = '[data-testid="nav-open"]'

const S = {
  home: {
    id: 'home',
    target: nav('/dashboard'),
    fallback: NAV_MENU,
    title: 'Home',
    body: 'Your dashboard shows what needs you today, across every deal.',
  },
  deals: {
    id: 'deals',
    target: nav('/deals'),
    fallback: NAV_MENU,
    title: 'Deals',
    body: "Each signed deal holds the brand's money until a reel is approved.",
  },
  review: {
    id: 'review',
    target: nav('/review'),
    fallback: NAV_MENU,
    title: 'Review',
    body: 'Cuts wait here for your decision, nearest deadline first.',
  },
  payables: {
    id: 'payables',
    target: nav('/payables'),
    fallback: NAV_MENU,
    title: 'Payables',
    body: 'Payables lists every payment your team is owed.',
  },
  concepts: {
    id: 'concepts',
    target: nav('/concepts'),
    fallback: NAV_MENU,
    title: 'Concepts',
    body: 'Ideas become concepts, and an approved concept starts a project.',
  },
  myMoney: {
    id: 'my-money',
    target: nav('/my-money'),
    fallback: NAV_MENU,
    title: "Where's my money",
    body: "My money shows what you've earned, what's held and what's paid.",
  },
  myWork: {
    id: 'my-work',
    target: nav('/my-work'),
    fallback: NAV_MENU,
    title: 'My work',
    body: 'My work lists the tasks assigned to you.',
  },
  projects: {
    id: 'projects',
    target: nav('/projects'),
    fallback: NAV_MENU,
    title: 'Projects',
    body: 'Open a project to upload a cut and follow it to live.',
  },
  calendar: {
    id: 'calendar',
    target: nav('/publishing/calendar'),
    fallback: NAV_MENU,
    title: 'Calendar',
    body: 'The calendar shows what goes out, and when.',
  },
  compose: {
    id: 'compose',
    target: nav('/publishing/compose'),
    fallback: NAV_MENU,
    title: 'Compose',
    body: 'Draft a post for an approved reel and pick its slot.',
  },
  chat: {
    id: 'chat',
    target: nav('/chat'),
    fallback: NAV_MENU,
    title: 'Team chat',
    body: 'Talk with your team in shared channels.',
  },
  brandBrain: {
    id: 'brand-brain',
    target: nav('/brand-brain'),
    fallback: NAV_MENU,
    title: 'Brand Brain',
    body: 'Ask Brand Brain about your brand rules, posts and results.',
  },
  again: {
    id: 'again',
    target: '[data-tour="avatar"]',
    title: 'Take the tour again',
    body: 'You can restart this tour any time from your account menu.',
  },
} satisfies Record<string, TourStep>

/** The demo project whose locked stage gate shows "What's missing" (seeded by the API demo). */
export const DEMO_GATE_PROJECT = 'Holiday gift reel (team draft)'

/**
 * The demo deal's steps: the money held, checks and the review clock on a reel
 * in review, then payday on a paid-out reel. Each step names its reel, since
 * the reel shown first can be a disputed one with no payout.
 */
export function demoDealSteps(
  dealPath: string,
  paidReel = 'reel1',
  clockReel = 'reel3',
): { held: TourStep; checks: TourStep; clock: TourStep; payday: TourStep } {
  const paid = `${dealPath}?reel=${paidReel}`
  const reel = `${dealPath}?reel=${clockReel}`
  return {
    held: {
      id: 'held',
      target: '[data-testid="deal-held"]',
      route: dealPath,
      title: 'Deal: held money',
      body: "PayPal holds the brand's money for this deal until each reel is approved.",
    },
    checks: {
      id: 'checks',
      target: '[data-testid="section-checks"]',
      route: reel,
      title: 'Checks on a reel',
      body: 'AI checks the facts in every cut against the brief.',
    },
    clock: {
      id: 'clock',
      target: '[data-testid="review-clock-card"]',
      route: reel,
      title: 'Review clock',
      body: 'The clock counts business days, and silence releases the money.',
    },
    payday: {
      id: 'payday',
      target: '[data-testid="section-payout"]',
      route: paid,
      title: 'Payday',
      body: 'Reel 1 was approved, so its team payout shows what each person got.',
    },
  }
}

/**
 * The demo user's tour follows the content-ops flow: concept, project and its
 * gates, the deal's held money, checks, the review clock, the review queue,
 * the calendar, payday, payables, chat and Brand Brain. projectPath is the
 * demo project with a locked gate; without it the step points at Projects.
 */
export function demoSteps(dealPath: string, projectPath?: string | null): TourStep[] {
  const d = demoDealSteps(dealPath)
  const project: TourStep = projectPath
    ? {
        id: 'projects',
        target: '[data-testid="lifecycle"]',
        route: projectPath,
        title: 'Projects',
        body: "Each project moves through stage gates, and What's missing lists what's left.",
      }
    : {
        id: 'projects',
        target: '[data-tour="page-projects"]',
        route: '/projects',
        title: 'Projects',
        body: "Each project moves through stage gates, and What's missing lists what's left.",
      }
  return [
    S.home,
    {
      id: 'concepts',
      target: '[data-tour="page-concepts"]',
      route: '/concepts',
      title: 'Concepts',
      body: 'Ideas from Brand Brain become concepts, and an approved one starts a project.',
    },
    project,
    d.held,
    d.checks,
    d.clock,
    {
      id: 'review',
      target: '[data-tour="page-review"]',
      route: '/review',
      title: 'Review queue',
      body: 'People own taste here, and every change they ask for cites a brief item.',
    },
    {
      id: 'calendar',
      target: '[data-testid="calendar-grid"]',
      route: '/publishing/calendar',
      title: 'Calendar',
      body: 'Approved reels get scheduled on the calendar.',
    },
    d.payday,
    {
      id: 'payables',
      target: '[data-tour="page-payables"]',
      route: '/payables',
      title: 'Payables',
      body: 'Payables lists every payment your team is owed.',
    },
    S.chat,
    S.brandBrain,
    S.again,
  ]
}

/**
 * The steps for a viewer. demoDeal is the seeded demo deal's path when the
 * viewer is the demo user; that tour walks the content-ops flow on the demo
 * data, and demoProject (optional) is the demo project with a locked gate.
 */
export function stepsFor(
  role: string,
  opts: { demoDeal?: string | null; demoProject?: string | null } = {},
): TourStep[] {
  switch (role) {
    case 'admin':
      return opts.demoDeal
        ? demoSteps(opts.demoDeal, opts.demoProject)
        : [
            S.home,
            S.concepts,
            S.projects,
            S.review,
            S.calendar,
            S.deals,
            S.payables,
            S.chat,
            S.brandBrain,
            S.again,
          ]
    case 'editor':
      return [S.home, S.myWork, S.projects, S.deals, S.myMoney, S.chat, S.brandBrain, S.again]
    case 'reviewer':
      return [S.home, S.review, S.deals, S.payables, S.chat, S.brandBrain, S.again]
    case 'publisher':
      return [S.home, S.calendar, S.compose, S.myMoney, S.chat, S.brandBrain, S.again]
    default:
      return [S.home, S.projects, S.myMoney, S.chat, S.brandBrain, S.again]
  }
}

/** Ask the mounted tour to start again (the avatar menu's "Take the tour"). */
export const TOUR_START_EVENT = 'yv:tour-start'
