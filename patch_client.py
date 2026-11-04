from pathlib import Path
p=Path(__file__).with_name('index.html');s=p.read_text()
s=s.replace("save=()=>localStorage.setItem(KEY,JSON.stringify(db))","save=()=>{if(!currentUser)return;clearTimeout(syncTimer);syncTimer=setTimeout(()=>api('/api/data',{method:'PUT',body:JSON.stringify(db)}).then(()=>setSync('클라우드 저장 완료')).catch(e=>setSync('저장 실패: '+e.message)),350)}")
s=s.replace("const KEY='persona_archive_v1';let db;", "let currentUser=null,syncTimer=null;const KEY='persona_archive_v1';let db;")
start=s.index('async function aiRequest(');end=s.index('async function aiTest()',start)
s=s[:start]+'''async function aiRequest(messages,signal){if(!currentUser)throw Error('로그인 후 이용해 주세요.');let result=await api('/api/ai',{method:'POST',body:JSON.stringify({provider:aiConfig.provider,messages}),signal});if(!result.text)throw Error('AI가 빈 응답을 반환했습니다.');return result.text}
'''+s[end:]
s=s.replace('render();\n</script>', '''render();initAccount();
</script>''')
# overlay before script, UI script definitions before render
s=s.replace('<script>','''<div id="account-overlay" style="position:fixed;inset:0;z-index:9999;background:#151423f5;display:flex;align-items:center;justify-content:center;padding:20px"><div class="panel" style="width:min(440px,100%);max-height:90vh;overflow:auto"><div class="section-kicker">LOREFRAME / PRIVATE WORKSPACE</div><h2>내 창작 공간에 로그인</h2><p class="muted">계정별로 캐릭터와 관계, 서사를 따로 저장합니다.</p><form id="account-form"><label>이메일</label><input id="account-email" type="email" required autocomplete="username"><label>비밀번호 (10자 이상)</label><input id="account-password" type="password" required minlength="10" autocomplete="current-password"><div class="actions" style="margin-top:16px"><button class="primary" type="submit">로그인</button><button type="button" onclick="accountAction('register')">새 계정 만들기</button></div></form><p id="account-message" class="ai-note" role="status">실제 서버를 실행해야 로그인과 클라우드 저장을 이용할 수 있습니다.</p></div></div><script>''',1)
needle='render();initAccount();'
code='''
async function api(url,opts={}){let r=await fetch(url,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});let d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'서버 오류');return d}
function setSync(message){let el=document.getElementById('sync-state');if(el)el.textContent=message}
async function accountAction(action){let email=document.getElementById('account-email').value,password=document.getElementById('account-password').value;try{let d=await api('/api/'+action,{method:'POST',body:JSON.stringify({email,password})});currentUser=d.user;await loadWorkspace();}catch(e){document.getElementById('account-message').textContent=e.message}}
async function initAccount(){document.getElementById('account-form').addEventListener('submit',e=>{e.preventDefault();accountAction('login')});try{let d=await api('/api/me');if(d.user){currentUser=d.user;await loadWorkspace()}}catch(e){document.getElementById('account-message').textContent='서버 연결이 필요합니다. README의 실행 방법을 확인해 주세요.'}}
async function loadWorkspace(){let d=await api('/api/data');db=d.data||{characters:[],relations:[],events:[]};document.getElementById('account-overlay').style.display='none';document.querySelector('footer').insertAdjacentHTML('beforeend',` · <span id="sync-state">계정: ${esc(currentUser.email)} · 동기화 준비</span> · <button onclick="logoutAccount()">로그아웃</button>`);render();setSync('클라우드 연결됨')}
async function logoutAccount(){if(syncTimer){clearTimeout(syncTimer);await api('/api/data',{method:'PUT',body:JSON.stringify(db)})}await api('/api/logout',{method:'POST'});location.reload()}
async function saveProviderKey(){let provider=aiConfig.provider,model=aiConfig.model,key=aiConfig.key;if(!key)return aiMsg('API 키를 입력해 주세요.');try{await api('/api/providers',{method:'POST',body:JSON.stringify({provider,model,key})});aiConfig.key='';document.getElementById('ai-key').value='';aiMsg('✓ API 키를 서버에 암호화해 저장했습니다.')}catch(e){aiMsg('저장 실패: '+e.message)}}
async function deleteProviderKey(){try{await api('/api/providers?provider='+encodeURIComponent(aiConfig.provider),{method:'DELETE'});aiMsg('연결 정보가 삭제되었습니다.')}catch(e){aiMsg(e.message)}}
'''
s=s.replace(needle,code+needle)
s=s.replace('<button onclick="aiTest()">연결 테스트</button>', '<button onclick="saveProviderKey()">🔐 API 키 저장</button><button onclick="aiTest()">연결 테스트</button><button onclick="deleteProviderKey()">연결 삭제</button>')
s=s.replace('API 키는 이 탭의 메모리에만 유지되며 새로고침·종료 시 사라집니다. 파일·백업·브라우저 저장소에 기록하지 않습니다.', 'API 키를 저장하면 계정별로 서버에서 암호화하여 보관합니다. 입력창의 키는 저장 직후 지워집니다.')
s=s.replace('API 키는 저장하지 않으며, 요청 시 선택한 제공업체로 캐릭터 설정이 전송됩니다.', 'API 키는 계정별로 서버에 암호화해 저장하며, 분석 요청 시 AI 제공업체로 캐릭터 설정이 전송됩니다.')
s=s.replace('기록은 현재 브라우저에 저장됩니다 · 사용자 직접 API 연결 · 키는 세션에만 보관 · 브라우저 로컬 저장','계정별 서버 저장 · API 키 암호화 보관 · 백업 내보내기 지원')
p.write_text(s)
