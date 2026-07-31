/**
 * @demo/worker-utils
 *
 * 3개 워커(collector, detector, actuator)에서 공통으로 사용하는
 * 유틸리티 함수 모음.
 *
 * 추출 배경:
 *   startMetricsServer와 startQueueDepthPoller가 각 워커에
 *   완전히 동일한 코드로 중복되어 있었음.
 */

import { createServer } from 'node:http'
import type { Db } from 'mongodb'
import type { Gauge } from 'prom-client'
import { register } from 'prom-client'

/** Agenda가 잡을 저장하는 MongoDB 컬렉션 이름 */
const AGENDA_COLLECTION = 'agendaJobs'

/**
 * Prometheus 메트릭 HTTP 서버를 기동한다.
 * 모든 워커의 /metrics 엔드포인트를 동일한 방식으로 노출한다.
 *
 * @param port       수신 포트 (collector=4010, detector=4011, actuator=4012)
 * @param workerName 로그에 표시할 워커 이름
 */
export function startMetricsServer(port: number, workerName: string): void {
  const server = createServer(async (_req, res) => {
    try {
      res.writeHead(200, { 'Content-Type': register.contentType })
      res.end(await register.metrics())
    } catch (err) {
      res.writeHead(500)
      res.end(String(err))
    }
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[${workerName}] Metrics server listening on :${port}/metrics`)
  })
}

/**
 * Agenda 잡 깊이를 주기적으로 샘플링하여 Prometheus Gauge에 기록한다.
 * 15초마다 agendaJobs 컬렉션에서 waiting/active 카운트를 각각 set한다.
 *
 * - waiting: lockedAt이 null이고 nextRunAt이 현재 시각 이전인 잡
 * - active: lockedAt이 설정되어 있는 잡 (현재 처리 중)
 *
 * @param db         MongoDB Db 인스턴스
 * @param jobName    샘플링할 Agenda 잡 이름
 * @param depthGauge `state` 레이블을 가진 Prometheus Gauge
 * @param intervalMs 샘플링 주기 (기본 15초)
 */
export function startQueueDepthPoller(
  db:         Db,
  jobName:    string,
  depthGauge: Gauge<'state'>,
  intervalMs = 15_000,
): void {
  const sample = async () => {
    try {
      const col = db.collection(AGENDA_COLLECTION)
      const now = new Date()
      const [waiting, active] = await Promise.all([
        col.countDocuments({ name: jobName, lockedAt: null, nextRunAt: { $lte: now } }),
        col.countDocuments({ name: jobName, lockedAt: { $ne: null } }),
      ])
      depthGauge.set({ state: 'waiting' }, waiting)
      depthGauge.set({ state: 'active'  }, active)
    } catch {
      // MongoDB 오류 시 무시
    }
  }
  void sample()
  setInterval(() => { void sample() }, intervalMs)
}
