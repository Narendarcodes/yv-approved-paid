/**
 * Helper copy: one plain line under each page title (8 words or fewer),
 * short hints on money / clock / change-order / dispute decisions, and one
 * line per empty state. work/simplify/COPY.md mirrors this file.
 * Sentence case, no marketing.
 */
export const PAGE_LINE = {
  '/dashboard': 'What needs you today, across every deal.',
  '/projects': 'Every reel, from idea to live.',
  '/concepts': 'Ideas to make next, ranked by past results.',
  '/review': 'Cuts waiting for your decision.',
  '/brand-brain': 'Ask about your brand, posts and results.',
  '/publishing/calendar': 'What goes out, and when.',
  '/publishing/compose': 'Draft a post and pick its slot.',
  '/publishing/channels': 'The accounts your posts go out to.',
  '/analytics': 'How your posts performed, by channel and time.',
  '/deals': 'Signed deals and the money each one holds.',
  '/payables': 'Every payment your team is owed.',
  '/my-money': "What you've earned, what's held, what's paid.",
  '/invoices': "Invoices you've sent and what's still unpaid.",
  '/contracts': 'Signed agreements with brands and your crew.',
  '/my-work': 'Tasks assigned to you, across projects.',
  '/chat': 'Talk with your team in shared channels.',
  '/profile': 'How you appear to your team.',
  '/settings': 'Your workspace, roles and notifications.',
} as const

export const HINT = {
  fund: 'PayPal holds the money; nothing is charged until approval.',
  approve: 'Approving captures the signed amount and pays the team.',
  clockSilence: 'No decision by the deadline releases money on the signed schedule.',
  requestChanges: 'Each change must cite a brief item or a failed check.',
  changeOrder: 'Accepting drafts a PayPal invoice for the quoted amount.',
  disputeSplit: 'Money moves only when both sides accept the split.',
  payablesApprove: 'You see a dry run before anything moves.',
  myMoney: 'Your signed share is paid after each approval.',
} as const

export const EMPTY_LINE = {
  deals: 'A deal appears here once both sides sign it.',
  payables: 'Held money shows up once a brand funds a reel. Money owed to you is in My money.',
  payablesFiltered: 'Clear the filters to see every payment.',
  myMoney: 'Your share lands here when a reel you worked on is approved.',
  projects: 'Start a project to plan, cut and ship a reel.',
  review: 'New cuts appear here when an editor uploads one.',
  pipeline: 'Nothing is waiting on anyone right now.',
  analytics: 'Numbers appear after your first post goes live.',
  contracts: 'Contracts you send or sign are kept here.',
  invoices: 'Create one, or accept a change order to draft one.',
  calendar: 'Schedule a post from Compose to fill this.',
  compose: 'Approve a project in Review to draft its post.',
  chatChannels: 'Create a channel to start talking with your team.',
  members: 'Invite people with the button above.',
  comments: 'Comments pinned to a moment in the cut show here.',
  activity: 'Changes to this project will be listed here.',
  brief: 'Pick a concept to start the brief.',
  moneyTrail: 'Every hold, capture and payout will be listed here.',
  published: 'Published posts and their numbers show here.',
} as const

/** Channels, Compose and Calendar while social publishing is in build. */
export const PUBLISHING_IN_BUILD = 'Social publishing is in build. Accounts connect on our side.'
export const PUBLISHING_PREVIEW = 'Preview: drafts and slots are saved, nothing posts yet.'

/** Dashboard: one helper line per section, and the one-line empty state each collapses to. */
export const DASH_LINE = {
  attention: 'Money and deadlines to watch this week.',
  stages: 'Every reel by stage. Tap a stage to list it.',
  waitingOn: 'Who holds the next step, and on what.',
  goingLive: 'Posts going out today, then the schedule.',
  review: 'Cuts waiting on a decision, nearest deadline first.',
  best: "Last week's top post by engagement.",
  activity: 'The latest moves, uploads and approvals.',
} as const

export const DASH_EMPTY = {
  attention: 'No money is held yet. It shows here once a brand funds a reel.',
  waitingOn: 'Nobody is waiting on anyone.',
  goingLive: 'Nothing today, and nothing scheduled.',
  review: 'No cuts are waiting on review.',
  best: 'No posts went live last week.',
  activity: 'No project activity yet.',
} as const
