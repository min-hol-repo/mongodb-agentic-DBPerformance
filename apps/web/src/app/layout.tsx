import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'
import { fetchHealth, DEFAULT_CLUSTER } from '@/lib/api'

export const metadata: Metadata = {
  title: 'Agentic Performance Demo',
  description: 'MongoDB Atlas 메트릭 기반 agentic 운영 보조 대시보드',
}

async function SystemStatus() {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected'
  try {
    const h = await fetchHealth()
    dbStatus = h.db
  } catch {
    // API 미기동 시 graceful
  }

  return (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className={`h-2 w-2 rounded-full ${
            dbStatus === 'connected' ? 'bg-green-500' : 'bg-red-400'
          }`}
        />
        DB {dbStatus === 'connected' ? 'connected' : 'offline'}
      </span>
    </div>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <div className="min-h-screen bg-gray-50">
          {/* ── Topbar ── */}
          <header className="sticky top-0 z-40 border-b bg-white shadow-sm">
            <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
              {/* 좌측: 브랜드 + 네비 */}
              <div className="flex items-center gap-6">
                <Link href="/" className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-widest text-slate-800">
                    Agentic Demo
                  </span>
                </Link>
                <nav className="flex items-center gap-1">
                  <NavLink href="/">Overview</NavLink>
                  <NavLink href={`/clusters/${DEFAULT_CLUSTER}`}>Cluster</NavLink>
                  <NavLink href="/actions">Actions</NavLink>
                  <NavLink href="/policies">Policies</NavLink>
                </nav>
              </div>
              {/* 우측: 시스템 상태 */}
              <SystemStatus />
            </div>
          </header>

          <main className="mx-auto max-w-7xl px-6 py-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      {children}
    </Link>
  )
}
