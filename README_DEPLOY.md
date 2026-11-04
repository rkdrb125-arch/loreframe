# LOREFRAME — 소규모 배포 가이드

## 권장 구성
Render **Starter 유료 웹서비스 + 1GB 영구 디스크 + SQLite**. 한 서비스만 관리하면 됩니다. 비용은 Render 요금표 기준 Starter 월 $7부터, 디스크 1GB 월 $0.25부터(세금/추가 사용량 별도)입니다. 실제 결제 전 Render 가격을 확인하세요.

Render Free 웹서비스에서는 SQLite가 재시작·휴면·재배포 시 삭제되므로 **실제 회원 데이터를 저장하면 안 됩니다**. Render Free Postgres도 30일 만료가 있어 영구 저장 대안으로 적합하지 않습니다.

## 1. 로컬 테스트
Node.js 22.13 이상 필요.
```bash
export APP_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm start
```
http://localhost:3000 접속, 회원가입, 캐릭터 등록, 새로고침 후 데이터 확인.

## 2. GitHub 업로드
이 폴더 내용을 **비공개 GitHub 저장소**에 업로드합니다. `.env`, `*.sqlite`, API 키는 절대 올리지 마세요.

## 3. Render 배포
1. Render 가입 → New → Blueprint → GitHub 저장소 연결
2. `render.yaml` 확인 후 배포. **Starter 유료 플랜과 1GB 디스크** 비용이 청구됩니다.
3. APP_SECRET 자동 생성 값은 분실하지 않도록 Render 환경 변수에서 관리합니다. 변경하면 저장된 API 키를 복호화할 수 없습니다.
4. Render가 발급한 HTTPS URL에 접속하여 회원가입/저장 테스트를 진행합니다.
5. 고유 도메인은 선택 사항입니다.

## 4. 운영 전 필수 점검
- 공개 회원가입을 활성화하기 전에 이메일 인증, 비밀번호 초기화, 가입/로그인 시도 제한, 남용 방지, CSRF 방어, 이용약관·개인정보 처리방침, 백업/복구 자동화 등을 추가하세요. 현재 프로젝트는 **비공개 소규모 베타용**입니다.
- 서버 환경 변수의 `APP_SECRET`과 SQLite DB를 **함께 백업**하세요. API 키는 AES-GCM으로 암호화되어 있으나 서버 운영자가 복호화할 수 있는 구조입니다.
- Render 디스크 스냅샷만 믿지 말고 별도 정기 백업을 계획하세요.
- API 요금은 각 사용자가 선택한 제공업체의 정책에 따릅니다.
- 서버 로그에 사용자 입력이나 API 키를 기록하지 마세요.

## 빠른 확인
`GET /healthz` → `{"ok":true}`. 공개 주소를 얻는 단계는 Render 계정 소유자가 직접 승인해야 합니다.
