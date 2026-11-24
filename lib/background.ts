import { after } from 'next/server'

// Work nobody should wait for. Inside a request it runs once the response has
// gone (next/server `after`), which is how the responder answers Live Chat
// inside its two seconds and then does the slow part. Outside one - a timer,
// the cron sweep, or inside an `after` of our own on a host that refuses a
// nested one - `after` throws, and the work simply starts now, detached.
// Either way it is never lost and never throws back at the caller.

export function runLater(label: string, task: () => Promise<void>): void {
  const run = () => task().catch((err: unknown) => { console.error(`[ai-agent-for-live-chat] ${label} failed`, err) })
  try {
    after(run)
  } catch {
    void run()
  }
}
