# Agentic Performance Demo

> **[English Documentation →](./README.md)**

MongoDB Atlas 메트릭을 수집하고, 룰 엔진으로 병목을 탐지하며, 스케일링 액션을 권고하거나 자동 적용하는 agentic 운영 보조 시스템입니다. 유일한 인프라 의존성은 MongoDB Atlas입니다.

Atlas 기본 자동 스케일링을 대체하는 것이 아니라, 그 위에서 동작하는 **상위 제어·설명·권고 계층**입니다.

> **현재 상태:** 이 프로젝트는 **개발 및 스테이징 환경**에 적용 가능합니다. 운영 환경에 적용하기 전에 다음 항목을 검토하고 보완하세요: API 키 시크릿 관리, 잡 재시도/백오프 설정, 페일오버 시 Atlas 프로세스 캐시 갱신, 통합 테스트 커버리지.

---

## 스크린샷

### Grafana — 전체 대시보드
![Grafana Overview Dashboard](./assets/screenshots/grafana-overview.png)

### Grafana — 메트릭 상세
![Grafana Metrics Detail](./assets/screenshots/grafana-detail.png)

### Prometheus — 메트릭 쿼리
![Prometheus Query](./assets/screenshots/prometheus-query.png)

### Web UI — 병목 이벤트 목록
![Web UI Event List](./assets/screenshots/webui-events.png)

---

## 목차

1. [아키텍처](#아키텍처)
2. [기술 스택](#기술-스택)
3. [사전 요구사항](#사전-요구사항)
4. [빠른 시작](#빠른-시작)
5. [환경 변수](#환경-변수)
6. [실행 방법](#실행-방법)
7. [데모 시나리오](#데모-시나리오)
8. [실제 Atlas 어댑터 사용](#실제-atlas-어댑터-사용)
9. [API 레퍼런스](#api-레퍼런스)
10. [관찰 가능성](#관찰-가능성)

---

## 아키텍처

```
                    ┌─────────────────────────────────┐
                    │     MongoDB Atlas 클러스터       │
                    │  (메트릭 소스 + 데이터 저장소)    │
                    └──────────┬──────────────┬────────┘
                               │ Atlas API    │ MongoDB
                               │ (HTTPS/443)  │ (27017)
                    ┌──────────▼──────┐        │
                    │   [Collector]   │        │
                    │  30초마다       │        │
                    └──────────┬──────┘        │
                               │               │ atlas_metrics_ts
                    ┌──────────▼──────┐        │
                    │   [Detector]    │◄────────┘
                    │  60초마다       │
                    │  4개 룰 엔진    │
                    └──────────┬──────┘
                               │ bottleneck_events
                    ┌──────────▼──────┐
                    │   [Actuator]    │
                    │  60초마다       │
                    │  + 즉시 트리거  │
                    └──────────┬──────┘
                               │ policy_actions
                    ┌──────────▼──────┐    ┌─────────────┐
                    │   [API 서버]    │◄───│  [Web UI]   │
                    │   Fastify/4000  │    │  Next.js    │
                    └─────────────────┘    └─────────────┘

      모든 워커 스케줄링은 MongoDB로 처리 (agendaJobs 컬렉션)
```

### 구성 요소

| 컴포넌트 | 경로 | 설명 |
|---|---|---|
| Web 대시보드 | `apps/web` | Next.js 14 운영자 대시보드 |
| API 서버 | `apps/api` | Fastify REST API |
| Collector | `workers/collector` | Atlas 메트릭 수집 워커 |
| Detector | `workers/detector` | 룰 기반 병목 탐지 워커 |
| Actuator | `workers/actuator` | 정책 기반 액션 생성 워커 |
| Shared | `packages/shared` | MongoDB 클라이언트, 타입, 리포지토리 |
| Atlas | `packages/atlas` | Atlas Metrics API 어댑터 (mock + 실제) |
| Rules | `packages/rules` | 룰 엔진 (4개 내장 룰) |
| Worker Utils | `packages/worker-utils` | Prometheus 메트릭 + 큐 깊이 폴러 |

### 탐지 룰

| 룰 ID | 트리거 조건 | 기본 심각도 |
|---|---|---|
| `RULE_CONN_001` | `connections ≥ 800` | medium → high |
| `RULE_CPU_001` | `cpuNormalizedPct ≥ 70%` | medium |
| `RULE_DISK_001` | `diskQueueDepth ≥ 3` AND `memoryUsedPct ≥ 80%` | high |
| `RULE_QUERY_001` | `queryTargeting ≥ 100` | medium (스케일 아닌 인덱스 개선 권고) |

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| 프론트엔드 | Next.js 14, React 18, Tailwind CSS, Recharts |
| 백엔드 | Fastify, TypeScript, ESM |
| 잡 스케줄링 | [Agenda](https://github.com/agenda/agenda) + MongoDB (`agendaJobs` 컬렉션) |
| 데이터베이스 | MongoDB Atlas (시계열 + 일반 컬렉션) |
| 메트릭 어댑터 | Atlas Admin API v2 (HTTP Digest 인증) |
| 관찰 가능성 | prom-client, Prometheus, Grafana |
| 모노레포 | pnpm workspaces, Turborepo |

> 잡 스케줄링은 동일한 MongoDB Atlas 클러스터를 백엔드로 사용하는 Agenda로 처리합니다.

---

## 사전 요구사항

| 도구 | 최소 버전 | 확인 명령 |
|---|---|---|
| Node.js | 20 | `node --version` |
| pnpm | 9 | `pnpm --version` |
| Docker | 24+ | `docker --version` |
| MongoDB Atlas | M10+ 클러스터 | Atlas 콘솔 |

> **MongoDB M10+가 필요합니다.** 실제 Atlas Metrics API 어댑터는 프로세스 레벨 메트릭을 사용하며, 이는 M0/M2/M5 공유 클러스터에서 지원되지 않습니다.  
> `COLLECTOR_ADAPTER=mock`을 사용하면 어떤 클러스터에서도 데모를 실행할 수 있습니다.

---

## 빠른 시작

```bash
# 1. 복제 및 의존성 설치
git clone <repo-url>
cd agentic-performance-demo
pnpm install

# 2. 환경 변수 설정
cp .env.example .env
# .env 파일을 열어 MONGODB_URI 최소 설정

# 3. 모니터링 인프라 기동 (Prometheus + Grafana)
docker compose -f infra/docker/docker-compose.infra.yml up -d

# 4. 서비스 시작 (터미널 5개)
pnpm --filter @demo/api dev               # 터미널 1
pnpm --filter @demo/web dev               # 터미널 2
pnpm --filter @demo/worker-collector dev  # 터미널 3
pnpm --filter @demo/worker-detector dev   # 터미널 4
pnpm --filter @demo/worker-actuator dev   # 터미널 5

# 5. 대시보드 열기
open http://localhost:3000
```

---

## 환경 변수

### 필수

| 변수 | 설명 |
|---|---|
| `MONGODB_URI` | MongoDB Atlas 연결 문자열 (`mongodb+srv://...`) |

### MongoDB

| 변수 | 기본값 | 설명 |
|---|---|---|
| `MONGODB_DB_NAME` | `agentic_demo` | 데이터베이스 이름 (첫 쓰기 시 자동 생성) |
| `ATLAS_CLUSTER_NAME` | `perf-demo` | 이벤트/액션 레이블에 사용되는 클러스터 식별자 |

### Atlas Metrics API (`COLLECTOR_ADAPTER=mcp` 시만 필요)

| 변수 | 설명 |
|---|---|
| `ATLAS_PROJECT_ID` | MongoDB Atlas 프로젝트 ID |
| `ATLAS_PUBLIC_KEY` | Atlas API 키 — 공개 키 |
| `ATLAS_PRIVATE_KEY` | Atlas API 키 — 비밀 키 |

필요 권한: **Project Read Only**

### Collector

| 변수 | 기본값 | 설명 |
|---|---|---|
| `COLLECTOR_ADAPTER` | `mock` | `mock` \| `mcp` |
| `COLLECTOR_MOCK_SCENARIO` | `normal` | `normal` \| `connection_surge` \| `cpu_saturation` \| `storage_pressure` \| `query_inefficiency` |
| `COLLECTOR_INTERVAL_SECONDS` | `30` | 수집 주기 (초) |
| `COLLECTOR_METRICS_PORT` | `4010` | Prometheus 스크레이프 포트 |

### Detector

| 변수 | 기본값 | 설명 |
|---|---|---|
| `RULE_WINDOW_MINUTES` | `5` | 룰 평가 슬라이딩 윈도우 (분) |
| `DETECTOR_METRICS_PORT` | `4011` | Prometheus 스크레이프 포트 |

### Actuator

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ACTUATOR_MODE` | `dry_run` | `dry_run` \| `approval_required` |
| `ACTUATOR_MAX_TIER` | `M60` | 스케일업 권고 상한 티어 |
| `ACTUATOR_COOLDOWN_MINUTES` | `30` | 동일 클러스터 액션 반복 방지 쿨다운 (분) |
| `ACTUATOR_METRICS_PORT` | `4012` | Prometheus 스크레이프 포트 |

### API 서버

| 변수 | 기본값 | 설명 |
|---|---|---|
| `API_PORT` | `4000` | API 수신 포트 |
| `API_HOST` | `0.0.0.0` | API 수신 호스트 |

### Web 대시보드

| 변수 | 기본값 | 설명 |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | 브라우저에서 사용하는 API 기본 URL |

---

## 실행 방법

### 방법 A: 로컬 개발 (권장)

인프라는 Docker, 앱은 로컬에서 핫 리로드로 실행합니다.

```bash
# 인프라 기동
docker compose -f infra/docker/docker-compose.infra.yml up -d

# 각각 별도 터미널에서
pnpm --filter @demo/api dev
pnpm --filter @demo/web dev
pnpm --filter @demo/worker-collector dev
pnpm --filter @demo/worker-detector dev
pnpm --filter @demo/worker-actuator dev
```

### 방법 B: 전체 Docker 스택

모든 서비스를 컨테이너로 한 번에 실행합니다.

```bash
docker compose -f infra/docker/docker-compose.yml up -d

# 로그 확인
docker compose -f infra/docker/docker-compose.yml logs -f collector
```

### 서비스 URL

| 서비스 | URL | 비고 |
|---|---|---|
| **Web 대시보드** | http://localhost:3000 | 운영자 대시보드 |
| **API 서버** | http://localhost:4000 | REST API |
| API 헬스 체크 | http://localhost:4000/api/health | 연결 상태 확인 |
| **Grafana** | http://localhost:3001 | 메트릭 시각화 (admin/admin) |
| **Prometheus** | http://localhost:9090 | 메트릭 쿼리 |
| Collector 메트릭 | http://localhost:4010/metrics | Prometheus 스크레이프 |
| Detector 메트릭 | http://localhost:4011/metrics | Prometheus 스크레이프 |
| Actuator 메트릭 | http://localhost:4012/metrics | Prometheus 스크레이프 |

---

## 데모 시나리오

전체 파이프라인을 가장 빠르게 확인하는 방법은 mock 어댑터와 병목 시나리오를 사용하는 것입니다.

### 시나리오 1: 정상 상태

```env
COLLECTOR_ADAPTER=mock
COLLECTOR_MOCK_SCENARIO=normal
```

이벤트/액션 없음. Grafana의 모든 게이지가 녹색으로 표시됩니다.

### 시나리오 2: 커넥션 급등 → 스케일업 권고

```env
COLLECTOR_ADAPTER=mock
COLLECTOR_MOCK_SCENARIO=connection_surge
```

**약 2분 후 일어나는 일:**
1. Collector가 30초마다 `connections ≈ 950` 삽입
2. Detector가 `RULE_CONN_001` 트리거 → `connection_pressure` 이벤트 생성
3. Detector가 Actuator에 즉시 `evaluate` 잡 추가 (60초 대기 없음)
4. Actuator가 `scale_up_request` 액션 생성

**확인:**
```bash
curl http://localhost:4000/api/clusters/perf-demo/events?status=open
curl http://localhost:4000/api/clusters/perf-demo/actions
```

**Web UI 탐색:**
- http://localhost:3000/clusters/perf-demo — 이벤트 목록, 권고 액션
- http://localhost:3000/actions — 액션 목록

### 시나리오 3: 쿼리 비효율 → 인덱스 개선 권고 (스케일 아님)

```env
COLLECTOR_ADAPTER=mock
COLLECTOR_MOCK_SCENARIO=query_inefficiency
```

`queryTargeting ≈ 180` → `RULE_QUERY_001` → 액션 타입: **`notify_only`**  
Actuator는 인덱스 검토를 권고하며 스케일업을 권고하지 않습니다.

### 시나리오 4: 승인 필요 워크플로우

```env
COLLECTOR_ADAPTER=mock
COLLECTOR_MOCK_SCENARIO=connection_surge
ACTUATOR_MODE=approval_required
```

API로 저장된 정책도 함께 업데이트해야 합니다:
```bash
curl -X PATCH http://localhost:4000/api/policies/perf-demo \
  -H "Content-Type: application/json" \
  -d '{"mode": "approval_required", "cooldownMinutes": 1}'
```

액션이 http://localhost:3000/actions 에 **승인 대기** 상태로 표시됩니다.

**API로 승인/거부:**
```bash
# 대기 중인 액션 ID 조회
ACTION_ID=$(curl -s "http://localhost:4000/api/clusters/perf-demo/actions?result=pending" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['actions'][0]['_id'])")

# 승인
curl -X POST "http://localhost:4000/api/actions/$ACTION_ID/approve"

# 거부 (사유 포함)
curl -X POST "http://localhost:4000/api/actions/$ACTION_ID/reject" \
  -H "Content-Type: application/json" \
  -d '{"reason": "메트릭이 안정화 중 — 재검토 예정"}'
```

### 시나리오 전환

`COLLECTOR_MOCK_SCENARIO`를 변경할 때는 **collector만 재시작**하면 됩니다.  
Detector와 Actuator는 계속 실행 중이어도 됩니다.

---

## 실제 Atlas 어댑터 사용

mock 데이터 대신 실제 Atlas 클러스터 메트릭을 수집하려면:

### 1. Atlas API 키 발급

Atlas UI → **Project → Access Manager → API Keys** → Create  
필요 권한: **Project Read Only**  
API 키 Access List에 현재 머신 IP 추가

### 2. `.env` 설정

```env
COLLECTOR_ADAPTER=mcp
ATLAS_PROJECT_ID=<프로젝트 ID>
ATLAS_PUBLIC_KEY=<공개 키>
ATLAS_PRIVATE_KEY=<비밀 키>
ATLAS_CLUSTER_NAME=<클러스터 이름>
```

### 3. 연결 확인

```bash
curl --user "<공개키>:<비밀키>" --digest \
  "https://cloud.mongodb.com/api/atlas/v2/groups/<project-id>/processes" \
  -H "Accept: application/vnd.atlas.2023-01-01+json" | python3 -m json.tool
```

### 수집되는 메트릭

| `NormalizedMetrics` 필드 | Atlas 메트릭 | API 엔드포인트 |
|---|---|---|
| `connections` | `CONNECTIONS` | 프로세스 |
| `cpuNormalizedPct` | `SYSTEM_NORMALIZED_CPU_USER` + `KERNEL` | 프로세스 |
| `memoryUsedPct` | `SYSTEM_MEMORY_USED / (USED + AVAILABLE) × 100` | 프로세스 |
| `diskUsedGb` | `DISK_PARTITION_SPACE_USED` ÷ 1 GiB | 디스크 파티션 |
| `diskQueueDepth` | `DISK_QUEUE_DEPTH` | 디스크 파티션 |
| `readLatencyMs` | `OP_EXECUTION_TIME_READS` | 프로세스 |
| `writeLatencyMs` | `OP_EXECUTION_TIME_WRITES` | 프로세스 |
| `queryTargeting` | `QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED` | 프로세스 |

> **참고:** Atlas API v2에서 일부 메트릭 이름은 `m=` 파라미터로 개별 요청이 불가능합니다. 어댑터는 전체 메트릭을 조회한 후 필요한 필드만 추출합니다.

### 네트워크 요구사항

Atlas Admin API (메트릭 수집)는 HTTPS/443 포트를 사용합니다.  
MongoDB 데이터 저장은 27017 포트를 사용합니다.  
현재 네트워크에서 27017 포트가 차단된 경우 Docker를 사용한 로컬 MongoDB로 대체 가능합니다:

```bash
docker run -d --name mongo-local -p 27017:27017 mongo:7
# .env에서 MONGODB_URI=mongodb://localhost:27017/agentic_demo 설정
```

---

## API 레퍼런스

### 헬스 체크

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/health` | 서버 + DB 연결 상태 |

### 이벤트

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/clusters/:name/events` | 병목 이벤트 목록 (필터: `status`, `severity`, `type`, `limit`, `since`) |
| `GET` | `/api/clusters/:name/events/open` | 현재 열린 이벤트만 조회 |
| `POST` | `/api/clusters/:name/detect-now` | 즉시 탐지 사이클 실행 |

### 액션

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/clusters/:name/actions` | 액션 목록 (필터: `result`, `limit`) |
| `GET` | `/api/actions/:id` | 단일 액션 조회 |
| `POST` | `/api/actions/:id/approve` | 대기 중 액션 승인 |
| `POST` | `/api/actions/:id/reject` | 대기 중 액션 거부 (body: `{ reason? }`) |

### 정책

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/policies/:name` | 클러스터 정책 조회 (없으면 기본값으로 자동 생성) |
| `PATCH` | `/api/policies/:name` | 정책 업데이트 (`mode`, `maxTier`, `cooldownMinutes`, `allowActions`, `blockedActions`) |

---

## 관찰 가능성

### Prometheus 주요 메트릭

| 메트릭 | 워커 | 설명 |
|---|---|---|
| `collector_run_total` | Collector | 총 수집 실행 횟수 |
| `collector_run_failures_total` | Collector | 실패한 수집 횟수 |
| `collector_run_duration_seconds` | Collector | 수집 소요 시간 히스토그램 |
| `atlas_metric_connections{cluster}` | Collector | 현재 커넥션 수 게이지 |
| `atlas_metric_cpu_normalized_pct` | Collector | CPU 사용률 게이지 |
| `detector_events_total{type,severity}` | Detector | 생성된 이벤트 카운터 |
| `detector_open_events{cluster}` | Detector | 현재 열린 이벤트 수 게이지 |
| `actuator_actions_total{action_type,mode}` | Actuator | 생성된 액션 카운터 |
| `actuator_approvals_total{decision}` | Actuator | 승인/거부 카운터 |
| `*_queue_depth{state}` | 전체 | Agenda 잡 큐 깊이 (waiting/active) |

### Grafana

http://localhost:3001 (익명 읽기 접근 가능, 로그인 불필요)

대시보드는 `infra/grafana/dashboards/`에서 자동 프로비저닝됩니다.

### MongoDB 컬렉션

| 컬렉션 | 타입 | 내용 |
|---|---|---|
| `atlas_metrics_ts` | 시계열 | Collector가 수집한 원시 메트릭 |
| `bottleneck_events` | 일반 | 탐지된 이벤트 (심각도, 룰 정보 포함) |
| `policy_actions` | 일반 | Actuator 권고 액션 및 승인 상태 |
| `actuator_policies` | 일반 | 클러스터별 Actuator 설정 |
| `agendaJobs` | 일반 | Agenda 잡 스케줄러 상태 (BullMQ/Redis 대체) |

---

## 프로젝트 구조

```
agentic-performance-demo/
├── apps/
│   ├── api/              # Fastify REST API 서버
│   └── web/              # Next.js 14 대시보드
├── packages/
│   ├── atlas/            # Atlas Metrics 어댑터 (mock + 실제 MCP)
│   ├── rules/            # 룰 엔진 (4개 탐지 룰)
│   ├── shared/           # MongoDB 클라이언트, 타입, 리포지토리
│   └── worker-utils/     # Prometheus 메트릭 서버 + 큐 깊이 폴러
├── workers/
│   ├── collector/        # 메트릭 수집 워커
│   ├── detector/         # 병목 탐지 워커
│   └── actuator/         # 정책 액션 워커
├── infra/
│   ├── docker/           # Dockerfile + docker-compose 파일
│   ├── prometheus/       # Prometheus 설정 + 알림 룰
│   └── grafana/          # Grafana 대시보드 + 프로비저닝
├── .env.example          # 환경 변수 템플릿
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

---

## 라이선스

MIT
