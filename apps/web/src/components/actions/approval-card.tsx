'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X, ChevronDown, ChevronUp, AlertTriangle, Clock } from 'lucide-react'
import { StatusBadge } from '@/components/ui/status-badge'
import { ACTION_LABELS, MODE_LABELS, relativeTime } from '@/lib/api'
import type { ActuatorAction } from '@/lib/api'
import { cn } from '@/lib/utils'

// ── 내부 상태 타입 ────────────────────────────────────────────────

type BtnState = 'idle' | 'loading' | 'done' | 'error'

// ── 유틸 ─────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

const ACTION_TYPE_COLORS: Record<string, string> = {
  scale_up_request:    'bg-orange-100 text-orange-700 border-orange-200',
  scale_recommendation: 'bg-blue-100 text-blue-700 border-blue-200',
  notify_only:          'bg-slate-100 text-slate-600 border-slate-200',
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────

interface ApprovalCardProps {
  action: ActuatorAction
}

export function ApprovalCard({ action }: ApprovalCardProps) {
  const router = useRouter()

  const [approveState, setApproveState] = useState<BtnState>('idle')
  const [rejectPhase,  setRejectPhase]  = useState<'idle' | 'confirming' | 'loading' | 'done' | 'error'>('idle')
  const [rejectReason, setRejectReason] = useState('')
  const [errorMsg,     setErrorMsg]     = useState('')
  const [auditOpen,    setAuditOpen]    = useState(false)

  const isScaleAction = action.actionType !== 'notify_only'
  const cooldownDate  = action.cooldownUntil ? new Date(action.cooldownUntil) : null

  // ── 승인 ─────────────────────────────────────────────────────
  async function handleApprove() {
    setApproveState('loading')
    setErrorMsg('')
    try {
      const res = await fetch(`${API_URL}/api/actions/${action._id}/approve`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setApproveState('done')
      setTimeout(() => router.refresh(), 600)
    } catch (err) {
      setErrorMsg((err as Error).message)
      setApproveState('error')
    }
  }

  // ── 거절 ─────────────────────────────────────────────────────
  async function handleRejectConfirm() {
    setRejectPhase('loading')
    setErrorMsg('')
    try {
      const res = await fetch(`${API_URL}/api/actions/${action._id}/reject`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reason: rejectReason.trim() || undefined }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setRejectPhase('done')
      setTimeout(() => router.refresh(), 600)
    } catch (err) {
      setErrorMsg((err as Error).message)
      setRejectPhase('error')
    }
  }

  // ── 완료 상태 ─────────────────────────────────────────────────
  if (approveState === 'done') {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-4">
        <div className="flex items-center gap-2 text-green-700">
          <Check className="h-4 w-4" />
          <span className="text-sm font-medium">Action approved</span>
        </div>
      </div>
    )
  }

  if (rejectPhase === 'done') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <div className="flex items-center gap-2 text-red-600">
          <X className="h-4 w-4" />
          <span className="text-sm font-medium">Action rejected</span>
        </div>
      </div>
    )
  }

  // ── 카드 본체 ─────────────────────────────────────────────────
  return (
    <div className="rounded-lg border bg-white overflow-hidden">
      {/* 헤더 바 */}
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-2">

          {/* 1행: 타입 + 모드 + 시각 */}
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status="pending" />
            <span
              className={cn(
                'rounded border px-2 py-0.5 text-xs font-semibold',
                ACTION_TYPE_COLORS[action.actionType] ?? 'bg-gray-100 text-gray-600 border-gray-200',
              )}
            >
              {ACTION_LABELS[action.actionType] ?? action.actionType}
            </span>
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700 border border-amber-200">
              {MODE_LABELS[action.mode]}
            </span>
            <span className="text-xs text-muted-foreground">{relativeTime(action.timestamp)}</span>
          </div>

          {/* 2행: ruleId + reason */}
          {action.ruleId && (
            <p className="font-mono text-xs text-muted-foreground">{action.ruleId}</p>
          )}
          {action.reason && (
            <p className="text-xs text-foreground/70">{action.reason}</p>
          )}

          {/* 3행: 상태 전이 (scale 액션만) */}
          {isScaleAction && action.beforeState && action.proposedState && (
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded bg-slate-100 px-2 py-0.5 font-mono font-medium text-slate-700">
                {String(action.beforeState.tier ?? JSON.stringify(action.beforeState))}
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="rounded bg-orange-100 px-2 py-0.5 font-mono font-medium text-orange-700">
                {String(action.proposedState.tier ?? JSON.stringify(action.proposedState))}
              </span>
              <span className="text-muted-foreground text-[10px]">proposed tier</span>
            </div>
          )}

          {/* 쿨다운 정보 */}
          {cooldownDate && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              Cooldown active until {cooldownDate.toLocaleTimeString('ko-KR')}
            </div>
          )}
        </div>

        {/* 버튼 영역 */}
        <div className="flex shrink-0 flex-col items-end gap-2">
          {/* 거절 확인 단계가 아닐 때만 승인 버튼 표시 */}
          {rejectPhase === 'idle' && (
            <button
              onClick={handleApprove}
              disabled={approveState === 'loading'}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors',
                approveState === 'loading'
                  ? 'border-green-200 bg-green-50 text-green-500 cursor-wait'
                  : 'border-green-400 bg-green-50 text-green-700 hover:bg-green-100 active:scale-95',
              )}
            >
              {approveState === 'loading' ? (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border border-green-400 border-t-transparent" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Approve
            </button>
          )}

          {/* 거절 버튼 */}
          {rejectPhase === 'idle' && (
            <button
              onClick={() => setRejectPhase('confirming')}
              className="flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100 active:scale-95"
            >
              <X className="h-3 w-3" />
              Reject
            </button>
          )}
        </div>
      </div>

      {/* 거절 확인 패널 */}
      {(rejectPhase === 'confirming' || rejectPhase === 'loading') && (
        <div className="border-t bg-red-50 px-4 py-3">
          <p className="mb-2 text-xs font-medium text-red-700">Confirm rejection</p>
          <input
            type="text"
            placeholder="Reason (optional)"
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            disabled={rejectPhase === 'loading'}
            className="mb-2 w-full rounded border border-red-200 bg-white px-2.5 py-1.5 text-xs text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-red-300"
          />
          <div className="flex gap-2">
            <button
              onClick={handleRejectConfirm}
              disabled={rejectPhase === 'loading'}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors',
                rejectPhase === 'loading'
                  ? 'border-red-200 bg-red-100 text-red-400 cursor-wait'
                  : 'border-red-400 bg-red-500 text-white hover:bg-red-600',
              )}
            >
              {rejectPhase === 'loading' ? (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border border-red-300 border-t-transparent" />
              ) : (
                <X className="h-3 w-3" />
              )}
              Confirm Reject
            </button>
            <button
              onClick={() => { setRejectPhase('idle'); setRejectReason('') }}
              disabled={rejectPhase === 'loading'}
              className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* 에러 메시지 */}
      {(approveState === 'error' || rejectPhase === 'error') && errorMsg && (
        <div className="border-t bg-red-50 px-4 py-2.5">
          <div className="flex items-center gap-1.5 text-xs text-red-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            onClick={() => { setApproveState('idle'); setRejectPhase('idle'); setErrorMsg('') }}
            className="mt-1 text-xs text-red-500 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 감사 로그 (접히는 섹션) */}
      {action.auditLog && action.auditLog.length > 0 && (
        <div className="border-t">
          <button
            onClick={() => setAuditOpen(v => !v)}
            className="flex w-full items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:bg-gray-50"
          >
            <span className="font-medium">Audit Log ({action.auditLog.length})</span>
            {auditOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {auditOpen && (
            <div className="divide-y border-t bg-gray-50 px-4 py-2">
              {action.auditLog.map((entry, i) => (
                <div key={i} className="flex items-start justify-between gap-3 py-2 text-xs">
                  <div>
                    <span className="font-mono text-muted-foreground">{entry.from}</span>
                    <span className="mx-1.5 text-muted-foreground">→</span>
                    <span className={cn(
                      'font-semibold',
                      entry.to === 'approved' ? 'text-green-700' : 'text-red-600',
                    )}>
                      {entry.to}
                    </span>
                    {entry.note && (
                       <span className="ml-2 text-muted-foreground italic">&quot;{entry.note}&quot;</span>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-muted-foreground">
                    <p>{entry.actor}</p>
                    <p>{new Date(entry.at).toLocaleTimeString('ko-KR')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
