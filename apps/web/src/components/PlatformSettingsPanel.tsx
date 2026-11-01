/**
 * Per-platform publishing settings in the composer. Mirrors the server's
 * validation (src/integrations/postiz/settings.js) so problems show inline
 * before scheduling; the server re-validates and its per-field details are
 * merged in via `serverErrors`.
 */
import { PLATFORMS } from '../lib/publishing'
import type { PlatformKey, PlatformSettings } from '../services/api'
import { PlatformIcon } from './status'

type FileLite = { id: string; filename: string; mimeType: string }
export type FieldError = { platform?: string; field: string; message: string }

const IG_MAX_COLLAB = 3
const X_MAX = 280
const IG_MAX = 2200

export function defaultSettings(platforms: PlatformKey[], ctx: { title: string; file: FileLite | null }, prev: PlatformSettings = {}): PlatformSettings {
  const out: PlatformSettings = {}
  for (const p of platforms) {
    if (p === 'instagram') out.instagram = prev.instagram ?? { format: ctx.file?.mimeType?.startsWith('video/') ? 'reel' : 'post', collaborators: [] }
    if (p === 'youtube') out.youtube = prev.youtube ?? { title: ctx.title.slice(0, 100), visibility: 'public', madeForKids: undefined, tags: [], thumbnailFileId: null }
    if (p === 'x') out.x = prev.x ?? { whoCanReply: 'everyone' }
    if (p === 'linkedin') out.linkedin = prev.linkedin ?? { carousel: false, carouselName: '' }
  }
  return out
}

export function validateSettings(s: PlatformSettings, ctx: { caption: string; file: FileLite | null; files: FileLite[] }): FieldError[] {
  const errs: FieldError[] = []
  const add = (platform: string, field: string, message: string) => errs.push({ platform, field, message })
  const isVideo = (f?: FileLite | null) => !!f && f.mimeType.startsWith('video/')
  const images = ctx.files.filter((f) => f.mimeType.startsWith('image/'))
  if (s.instagram) {
    if (!ctx.file) add('instagram', 'media', 'Instagram needs an image or video')
    if (s.instagram.format === 'reel' && ctx.file && !isVideo(ctx.file)) add('instagram', 'format', 'A Reel needs a video file')
    if (ctx.caption.length > IG_MAX) add('instagram', 'caption', `Instagram captions are limited to ${IG_MAX} characters`)
    if (s.instagram.collaborators.length > IG_MAX_COLLAB) add('instagram', 'collaborators', `Instagram allows up to ${IG_MAX_COLLAB} collaborators`)
    for (const c of s.instagram.collaborators) if (!/^@?[A-Za-z0-9._]{1,30}$/.test(c)) add('instagram', 'collaborators', `"${c}" is not a valid Instagram username`)
    if (s.instagram.format === 'story' && s.instagram.collaborators.length) add('instagram', 'collaborators', 'Stories cannot have collaborators')
  }
  if (s.youtube) {
    const t = s.youtube.title.trim()
    if (t.length < 2 || t.length > 100) add('youtube', 'title', 'YouTube title must be 2-100 characters')
    if (typeof s.youtube.madeForKids !== 'boolean') add('youtube', 'madeForKids', 'Say whether the video is made for kids (required by YouTube)')
    if (!isVideo(ctx.file)) add('youtube', 'media', 'YouTube needs a video file')
    if (s.youtube.tags.length > 15) add('youtube', 'tags', 'Use at most 15 tags')
  }
  if (s.x && ctx.caption.length > X_MAX) add('x', 'caption', `X posts are limited to ${X_MAX} characters (${ctx.caption.length} now)`)
  if (s.linkedin?.carousel && images.length < 2) add('linkedin', 'carousel', 'A LinkedIn carousel needs at least 2 images in the approved version')
  return errs
}

const splitList = (v: string) =>
  v
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean)

export function PlatformSettingsPanel({
  value,
  onChange,
  errors,
  files,
}: {
  value: PlatformSettings
  onChange: (v: PlatformSettings) => void
  errors: FieldError[]
  files: FileLite[]
}) {
  const platforms = (Object.keys(value) as PlatformKey[]).filter((k) => value[k])
  if (!platforms.length) return <p className="mt-3 text-sm text-umber">Pick channels to see their settings.</p>
  const errFor = (p: string, f: string) => errors.filter((e) => e.platform === p && e.field === f).map((e) => e.message)
  const Err = ({ p, f }: { p: string; f: string }) => {
    const m = errFor(p, f)
    return m.length ? (
      <p className="mt-1 text-xs text-danger" role="alert" data-testid={`err-${p}-${f}`}>
        {m.join(' · ')}
      </p>
    ) : null
  }
  const images = files.filter((f) => f.mimeType.startsWith('image/'))
  const label = 'block text-xs font-medium text-umber'
  return (
    <div className="mt-3 space-y-3" data-testid="platform-settings">
      {platforms.map((p) => (
        <div key={p} className="rounded-[10px] border border-line p-4" data-testid={`settings-${p}`}>
          <div className="mb-3 flex items-center gap-2">
            <PlatformIcon platform={p} size="sm" />
            <span className="text-sm font-semibold text-ink">{PLATFORMS[p].label}</span>
            <Err p={p} f="media" />
            <Err p={p} f="caption" />
          </div>
          {p === 'instagram' && value.instagram && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={label}>
                Format
                <select
                  className="input mt-1 w-full"
                  value={value.instagram.format}
                  onChange={(e) => onChange({ ...value, instagram: { ...value.instagram!, format: e.target.value as 'post' } })}
                  data-testid="ig-format"
                >
                  <option value="post">Feed post</option>
                  <option value="reel">Reel</option>
                  <option value="story">Story</option>
                </select>
                <Err p="instagram" f="format" />
              </label>
              <label className={label}>
                Collaborators (up to 3)
                <input
                  className="input mt-1 w-full"
                  placeholder="@studio, @kavya.makes"
                  defaultValue={value.instagram.collaborators.join(', ')}
                  onBlur={(e) => onChange({ ...value, instagram: { ...value.instagram!, collaborators: splitList(e.target.value) } })}
                  data-testid="ig-collaborators"
                />
                <Err p="instagram" f="collaborators" />
              </label>
            </div>
          )}
          {p === 'youtube' && value.youtube && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={`${label} sm:col-span-2`}>
                Title <span className="font-mono text-label">{value.youtube.title.length}/100</span>
                <input
                  className="input mt-1 w-full"
                  value={value.youtube.title}
                  onChange={(e) => onChange({ ...value, youtube: { ...value.youtube!, title: e.target.value } })}
                  data-testid="yt-title"
                />
                <Err p="youtube" f="title" />
              </label>
              <label className={label}>
                Visibility
                <select
                  className="input mt-1 w-full"
                  value={value.youtube.visibility}
                  onChange={(e) => onChange({ ...value, youtube: { ...value.youtube!, visibility: e.target.value as 'public' } })}
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
              </label>
              <fieldset className={label}>
                <legend>Made for kids?</legend>
                <div className="mt-2 flex gap-4 text-sm text-ink">
                  {[
                    ['no', false],
                    ['yes', true],
                  ].map(([l, v]) => (
                    <label key={String(l)} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="yt-kids"
                        checked={value.youtube!.madeForKids === v}
                        onChange={() => onChange({ ...value, youtube: { ...value.youtube!, madeForKids: v as boolean } })}
                        data-testid={`yt-kids-${l}`}
                      />
                      {l === 'yes' ? 'Yes' : 'No'}
                    </label>
                  ))}
                </div>
                <Err p="youtube" f="madeForKids" />
              </fieldset>
              <label className={label}>
                Tags
                <input
                  className="input mt-1 w-full"
                  placeholder="diwali, workshop"
                  defaultValue={value.youtube.tags.join(', ')}
                  onBlur={(e) => onChange({ ...value, youtube: { ...value.youtube!, tags: splitList(e.target.value) } })}
                />
                <Err p="youtube" f="tags" />
              </label>
              <label className={label}>
                Thumbnail
                <select
                  className="input mt-1 w-full"
                  value={value.youtube.thumbnailFileId || ''}
                  onChange={(e) => onChange({ ...value, youtube: { ...value.youtube!, thumbnailFileId: e.target.value || null } })}
                >
                  <option value="">Auto (YouTube picks a frame)</option>
                  {images.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.filename}
                    </option>
                  ))}
                </select>
                <Err p="youtube" f="thumbnail" />
              </label>
            </div>
          )}
          {p === 'x' && value.x && (
            <label className={label}>
              Who can reply
              <select
                className="input mt-1 w-full sm:w-64"
                value={value.x.whoCanReply}
                onChange={(e) => onChange({ ...value, x: { whoCanReply: e.target.value as 'everyone' } })}
                data-testid="x-reply"
              >
                <option value="everyone">Everyone</option>
                <option value="following">Accounts you follow</option>
                <option value="mentionedUsers">Only people you mention</option>
                <option value="subscribers">Subscribers</option>
                <option value="verified">Verified accounts</option>
              </select>
            </label>
          )}
          {p === 'linkedin' && value.linkedin && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={value.linkedin.carousel}
                  onChange={(e) => onChange({ ...value, linkedin: { ...value.linkedin!, carousel: e.target.checked } })}
                  data-testid="li-carousel"
                />
                Post images as a carousel ({images.length} image{images.length === 1 ? '' : 's'} in the approved version)
              </label>
              {value.linkedin.carousel && (
                <input
                  className="input w-56"
                  placeholder="Carousel name (optional)"
                  value={value.linkedin.carouselName || ''}
                  onChange={(e) => onChange({ ...value, linkedin: { ...value.linkedin!, carouselName: e.target.value } })}
                />
              )}
              <div className="w-full">
                <Err p="linkedin" f="carousel" />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
