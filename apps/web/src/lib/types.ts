/**
 * Shared domain types for yv..
 *
 * This is the single source of truth for domain types used across the
 * frontend. API response types (auth session, organization, etc.) are defined
 * in services/api.ts and imported here to avoid duplication.
 *
 * All runtime data comes exclusively from the backend API.
 */

export type RoleName = 'admin' | 'editor' | 'reviewer' | 'designer' | 'publisher' | 'member'

export interface TeamMember {
  id: string
  name: string
  initials: string
  email: string
  role: RoleName
  title: string
  lastActive: string
  /** Invited (demo) and not signed up yet. */
  pending?: boolean
  disabled?: boolean
}

/** PRD lifecycle statuses - see statusLabel() helpers where rendered. */
export interface Project {
  id: string
  title: string
  type: 'New Concept' | 'Experiment' | 'Revision' | 'Content Production'
  status: string
  description: string
  assignee: string // team member id
  creator: string
  reviewers: string[]
  updated: string
  scheduleDate?: string
  platform?: string
  postUrl?: string
  publishedAt?: string
  approvedVersion?: string
  /** Id of the version locked by approval, when one is. */
  approvedVersionId?: string | null
  /** The deal milestone this project delivers, when it is tied to one. */
  dealId?: string | null
  milestoneKey?: string | null
  publishProgress?: { published: number; total: number } | null
  conceptId?: string | null
}

/** Re-export auth/session types so pages can import from one place. */
export type { SessionUser, Session, Org, OrgMember } from '../services/api'
