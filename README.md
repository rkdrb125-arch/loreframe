# LOREFRAME Web Service

Node.js 22.13 이상에서 실행하는 자체 호스팅 웹서비스입니다. 기존 Studio 5.0의 캐릭터·관계·서사·AI 생성 기능에 계정별 데이터 저장과 서버 AI 중계를 추가했습니다.

## 시작하기

터미널에서 프로젝트 폴더로 이동한 뒤:

macOS/Linux:
```bash
export APP_SECRET="$(openssl rand -hex 32)"
node server.js
```
Windows PowerShell:
```powershell
$env:APP_SECRET = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
node server.js
```

브라우저에서 `http://127.0.0.1:3000`에 접속해 회원가입합니다. API 연결은 AI 스튜디오에서 키와 모델을 입력하고 **API 키 저장**을 누른 다음 테스트합니다.

## 운영 주의

- 서버가 실행되는 PC에 SQLite 데이터베이스 `loreframe.sqlite`가 만들어집니다. 계정별 데이터는 브라우저가 아닌 이 DB에 저장됩니다.
- 다른 기기에서도 접속하려면 서버 배포와 HTTPS 도메인이 필요합니다. 현재 파일만 열어서는 로그인할 수 없습니다.
- `APP_SECRET`은 재시작 후에도 같은 값을 유지하고 안전하게 보관해야 합니다. 바뀌면 기존 암호화 API 키를 복호화할 수 없습니다.
- 공개 배포 전 HTTPS, 이메일 인증/비밀번호 재설정, CSRF 방어, 계정별 사용량·비용 제한, 백업 및 모니터링을 추가해야 합니다. 이 버전은 개인/소규모 테스트용입니다.
- API 요청은 서버에서 공급업체로 전송되며, API 키는 AES-256-GCM으로 암호화해 SQLite에 저장합니다. 앱 서버 운영자는 원칙적으로 서버 비밀키에 접근할 수 있으므로 제3자 호스팅의 신뢰가 필요합니다.
- 기존 단일 HTML에서 만든 데이터는 JSON 백업 파일을 내려받은 뒤 로그인한 계정에서 가져오세요. 자동으로 로컬 데이터를 업로드하지 않습니다.
