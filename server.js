'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=Number(process.env.PORT||3000), HOST=process.env.HOST||'0.0.0.0';
const secret=process.env.APP_SECRET;
if(!secret||secret.length<32){console.error('APP_SECRET 환경변수에 32자 이상의 임의 문자열을 설정하세요.');process.exit(1)}
const encKey=crypto.createHash('sha256').update(secret).digest();
const dbPath=process.env.DB_PATH||path.join(__dirname,'loreframe.sqlite');
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db=new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,salt TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS documents(user_id TEXT PRIMARY KEY,body TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS providers(user_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,key_cipher TEXT NOT NULL,PRIMARY KEY(user_id,provider));`);
// Account approval migration (safe for existing databases)
for(const col of ["role TEXT NOT NULL DEFAULT 'member'","status TEXT NOT NULL DEFAULT 'pending'"]){
  try{db.exec('ALTER TABLE users ADD COLUMN '+col)}catch(e){if(!/duplicate column name/i.test(e.message))throw e}
}
const adminEmail=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
const bootstrapKey=String(process.env.ADMIN_SETUP_KEY||'');
const json=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))};
const parse=async(req)=>{let raw='';for await(const c of req){raw+=c;if(raw.length>1024*1024)throw Error('요청 크기 제한 초과')}return JSON.parse(raw||'{}')};
const token=()=>crypto.randomBytes(32).toString('base64url');
const cookie=(req)=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=').slice(0,2)).filter(x=>x.length===2));
const getUser=(req)=>{let t=cookie(req).lf_session;if(!t)return null;let row=db.prepare('SELECT u.id,u.email,u.role,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(crypto.createHash('sha256').update(t).digest('hex'),Date.now());return row||null};
const pwHash=(p,s)=>crypto.pbkdf2Sync(p,s,210000,32,'sha256').toString('hex');
const encrypt=(s)=>{let iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',encKey,iv),data=Buffer.concat([c.update(s,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64')};
const decrypt=(s)=>{let b=Buffer.from(s,'base64'),d=crypto.createDecipheriv('aes-256-gcm',encKey,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8')};
const models={gemini:'gemini-2.5-flash',openai:'gpt-4.1-mini',anthropic:'claude-sonnet-4-5',openrouter:'openai/gpt-4.1-mini'};
async function inference(provider,key,model,messages){let url,headers={'Content-Type':'application/json'},body;let system=String(messages[0]?.content||''),user=String(messages[1]?.content||'');if(provider==='gemini'){url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;headers['x-goog-api-key']=key;body={systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:user}]}],generationConfig:{temperature:.75,maxOutputTokens:3500}}}else if(provider==='anthropic'){url='https://api.anthropic.com/v1/messages';headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';body={model,max_tokens:3500,system,messages:[{role:'user',content:user}]}}else{url=provider==='openrouter'?'https://openrouter.ai/api/v1/chat/completions':'https://api.openai.com/v1/chat/completions';headers.Authorization=`Bearer ${key}`;body={model,messages,temperature:.7}}let r=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});let d=await r.json().catch(()=>({}));if(!r.ok)throw Error(`AI 제공업체 오류 ${r.status}: ${String(d.error?.message||d.message||'연결 설정을 확인하세요').slice(0,250)}`);return provider==='gemini'?(d.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join(''):provider==='anthropic'?(d.content||[]).map(x=>x.text||'').join(''):d.choices?.[0]?.message?.content||''}
const rate=new Map();
const server=http.createServer(async(req,res)=>{try{
res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
let u=new URL(req.url,'http://localhost'),p=u.pathname,method=req.method;
if(p==='/healthz'&&method==='GET')return json(res,200,{ok:true});
if(['POST','PUT','DELETE','PATCH'].includes(method)){let origin=req.headers.origin;let host=req.headers['x-forwarded-host']||req.headers.host;let proto=req.headers['x-forwarded-proto']||'http';if(origin){let expected=process.env.PUBLIC_ORIGIN||`${proto}://${host}`;if(origin!==expected)return json(res,403,{error:'허용되지 않은 출처입니다.'});}}
if(p==='/'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return fs.createReadStream(path.join(__dirname,'index.html')).pipe(res)}
if (
  !p.startsWith('/api/') &&
  p !== '/admin-setup' &&
  p !== '/admin'
) {
  return json(res, 404, { error: '찾을 수 없습니다' });
}
if(p==='/api/me'&&method==='GET')return json(res,200,{user:getUser(req)});
// One-time administrator enrollment. The setup key is never returned to the browser.
if(p==='/admin-setup'&&method==='GET'){
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",'X-Content-Type-Options':'nosniff'});
 return res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LOREFRAME 관리자 설정</title><style>body{font-family:system-ui;background:#f8f7f2;color:#263a30;max-width:440px;margin:9vh auto;padding:20px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;border:1px solid #b7c5b9;border-radius:9px}button{background:#487454;color:white;cursor:pointer}small{color:#64756a}</style><h2>LOREFRAME 관리자 초기 설정</h2><small>Render에 설정한 ADMIN_EMAIL과 ADMIN_SETUP_KEY가 필요합니다. 관리자 계정이 이미 있다면 재설정할 수 없습니다.</small><form id="f"><input type="email" name="email" placeholder="관리자 이메일" required><input type="password" name="password" placeholder="관리자 비밀번호 (10자 이상)" minlength="10" required><input type="password" name="setupKey" placeholder="ADMIN_SETUP_KEY" required><button>관리자 계정 설정</button></form><p id="result"></p><script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const f=e.target;const data=Object.fromEntries(new FormData(f));try{const r=await fetch('/api/admin/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const d=await r.json();document.getElementById('result').textContent=d.error||'관리자 설정 완료! 메인 화면에서 로그인하세요.';}catch(e){document.getElementById('result').textContent='연결 오류';}}</script></html>`);
}
if(p==='/admin'&&method==='GET'){
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",'X-Content-Type-Options':'nosniff'});
 return res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LOREFRAME 회원 승인 관리</title><style>body{font-family:system-ui;background:#f8f7f2;color:#243b2b;max-width:760px;margin:6vh auto;padding:18px}article{background:white;padding:16px;margin:12px 0;border-radius:12px;border:1px solid #d7dfd5}button{border:0;border-radius:8px;padding:9px 12px;margin:5px;background:#4e7b58;color:white;cursor:pointer}button.alt{background:#8c6969}small{color:#63766a}</style><h2>LOREFRAME 회원 승인 관리</h2><p id="msg">회원 목록을 불러오는 중입니다.</p><section id="users"></section><script>async function load(){let r=await fetch('/api/admin/users');let d=await r.json();const msg=document.getElementById('msg'),root=document.getElementById('users');root.replaceChildren();if(!r.ok){msg.textContent=d.error||'오류';return;}msg.textContent='회원 '+d.users.length+'명';for(let u of d.users){let card=document.createElement('article');let title=document.createElement('strong');title.textContent=u.email;card.append(title);let meta=document.createElement('p');meta.textContent=(u.role==='admin'?'관리자':'일반 회원')+' · '+u.status;card.append(meta);if(u.role!=='admin'){for(let [status,label] of [['approved','승인'],['rejected','거절'],['blocked','정지'],['pending','대기']]){let b=document.createElement('button');b.textContent=label;if(status==='rejected'||status==='blocked')b.className='alt';b.onclick=async()=>{if(!confirm(u.email+' 계정을 '+label+' 처리할까요?'))return;let r=await fetch('/api/admin/users/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:u.id,status})});let d=await r.json();if(!r.ok)alert(d.error||'오류');await load();};card.append(b);}}root.append(card);}}load();</script></html>`);
}
if(p==='/api/admin/bootstrap'&&method==='POST'){
 if(!adminEmail||bootstrapKey.length<24)return json(res,503,{error:'ADMIN_EMAIL 및 24자 이상의 ADMIN_SETUP_KEY 환경변수를 설정하세요.'});
 if(db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get())return json(res,409,{error:'관리자가 이미 등록되어 있습니다.'});
 let b=await parse(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),provided=String(b.setupKey||'');
 const a=crypto.createHash('sha256').update(provided).digest(),z=crypto.createHash('sha256').update(bootstrapKey).digest();
 if(email!==adminEmail||!crypto.timingSafeEqual(a,z))return json(res,403,{error:'관리자 이메일 또는 설정 키가 올바르지 않습니다.'});
 if(password.length<10||password.length>200)return json(res,400,{error:'비밀번호는 10~200자로 입력하세요.'});
 let existing=db.prepare('SELECT id,hash,salt FROM users WHERE email=?').get(email);
 if(existing){if(!crypto.timingSafeEqual(Buffer.from(pwHash(password,existing.salt),'hex'),Buffer.from(existing.hash,'hex')))return json(res,403,{error:'기존 계정의 비밀번호가 올바르지 않습니다.'});db.prepare("UPDATE users SET role='admin',status='approved' WHERE id=?").run(existing.id)}
 else{let salt=crypto.randomBytes(16).toString('hex');db.prepare('INSERT INTO users(id,email,hash,salt,created_at,role,status) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),email,pwHash(password,salt),salt,Date.now(),'admin','approved')}
 return json(res,200,{ok:true});
}
if(p==='/api/register'&&method==='POST'){let b=await parse(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(!/^\S+@\S+\.\S+$/.test(email)||email.length>200||password.length<10||password.length>200)return json(res,400,{error:'이메일과 10자 이상 비밀번호가 필요합니다.'});if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return json(res,409,{error:'이미 등록된 이메일입니다.'});let salt=crypto.randomBytes(16).toString('hex'),id=crypto.randomUUID();db.prepare("INSERT INTO users(id,email,hash,salt,created_at,role,status) VALUES(?,?,?,?,?,'member','pending')").run(id,email,pwHash(password,salt),salt,Date.now());return login(id,email)}
if(p==='/api/login'&&method==='POST'){let b=await parse(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');let row=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!row||!crypto.timingSafeEqual(Buffer.from(pwHash(password,row.salt),'hex'),Buffer.from(row.hash,'hex')))return json(res,401,{error:'이메일 또는 비밀번호가 올바르지 않습니다.'});if(row.status==='blocked'||row.status==='rejected')return json(res,403,{error:'이용이 제한된 계정입니다.'});return login(row.id,row.email)}
function login(id,email){let t=token();db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(t).digest('hex'),id,Date.now()+7*86400000);res.setHeader('Set-Cookie',`lf_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`);return json(res,200,{user:db.prepare('SELECT id,email,role,status FROM users WHERE id=?').get(id)})}
let user=getUser(req);if(!user)return json(res,401,{error:'로그인이 필요합니다.'});
if(p==='/api/admin/users'&&method==='GET'){
 if(user.role!=='admin'||user.status!=='approved')return json(res,403,{error:'관리자 권한이 필요합니다.'});
 return json(res,200,{users:db.prepare('SELECT id,email,role,status,created_at FROM users ORDER BY created_at DESC').all()});
}
if(p==='/api/admin/users/status'&&method==='POST'){
 if(user.role!=='admin'||user.status!=='approved')return json(res,403,{error:'관리자 권한이 필요합니다.'});
 let b=await parse(req),id=String(b.id||''),status=String(b.status||'');
 if(!['approved','rejected','blocked','pending'].includes(status))return json(res,400,{error:'올바르지 않은 상태입니다.'});
 let target=db.prepare('SELECT id,role FROM users WHERE id=?').get(id);
 if(!target)return json(res,404,{error:'계정을 찾을 수 없습니다.'});
 if(target.role==='admin')return json(res,403,{error:'관리자 계정 상태는 변경할 수 없습니다.'});
 db.prepare('UPDATE users SET status=? WHERE id=?').run(status,id);
 if(status!=='approved')db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
 return json(res,200,{ok:true});
}
if(p==='/api/logout'&&method==='POST'){let t=cookie(req).lf_session;if(t)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(t).digest('hex'));res.setHeader('Set-Cookie','lf_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true})}
if(user.status!=='approved')return json(res,403,{error:'관리자 승인 후 이용할 수 있습니다.'});
if(p==='/api/data'&&method==='GET'){let row=db.prepare('SELECT body,updated_at FROM documents WHERE user_id=?').get(user.id);return json(res,200,{data:row?JSON.parse(row.body):null,updatedAt:row?.updated_at||null})}
if(p==='/api/data'&&method==='PUT'){let b=await parse(req);if(!b||!Array.isArray(b.characters)||!Array.isArray(b.relations)||!Array.isArray(b.events))return json(res,400,{error:'데이터 형식이 올바르지 않습니다.'});let body=JSON.stringify(b);if(body.length>900000)return json(res,413,{error:'저장 용량을 초과했습니다.'});db.prepare('INSERT INTO documents VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at').run(user.id,body,Date.now());return json(res,200,{ok:true})}
if(p==='/api/providers'&&method==='GET'){let rows=db.prepare('SELECT provider,model FROM providers WHERE user_id=?').all(user.id);return json(res,200,{providers:rows})}
if(p==='/api/providers'&&method==='POST'){let b=await parse(req),provider=String(b.provider||''),model=String(b.model||'').trim(),key=String(b.key||'').trim();if(!models[provider]||!model||model.length>150||key.length<8||key.length>500)return json(res,400,{error:'제공업체, 모델 ID, API 키를 확인해 주세요.'});db.prepare('INSERT INTO providers VALUES(?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET model=excluded.model,key_cipher=excluded.key_cipher').run(user.id,provider,model,encrypt(key));return json(res,200,{ok:true})}
if(p==='/api/providers'&&method==='DELETE'){let provider=String(u.searchParams.get('provider')||'');db.prepare('DELETE FROM providers WHERE user_id=? AND provider=?').run(user.id,provider);return json(res,200,{ok:true})}
if(p==='/api/ai'&&method==='POST'){let now=Date.now(),r=rate.get(user.id)||[];r=r.filter(x=>now-x<60000);if(r.length>=12)return json(res,429,{error:'분당 최대 12회 요청할 수 있습니다.'});r.push(now);rate.set(user.id,r);let b=await parse(req),provider=String(b.provider||''),row=db.prepare('SELECT model,key_cipher FROM providers WHERE user_id=? AND provider=?').get(user.id,provider);if(!row)return json(res,400,{error:'먼저 AI 연결 설정에서 API 키를 저장하세요.'});let messages=b.messages;if(!Array.isArray(messages)||messages.length!==2||messages.some(x=>typeof x.content!=='string'||x.content.length>30000))return json(res,400,{error:'분석 요청 형식이 올바르지 않습니다.'});let result=await inference(provider,decrypt(row.key_cipher),row.model,messages);return json(res,200,{text:result})}
return json(res,404,{error:'지원하지 않는 요청입니다.'});
}catch(e){console.error(e.message);return json(res,500,{error:e.message==='요청 크기 제한 초과'?e.message:'요청 처리 중 오류가 발생했습니다. 서버 로그를 확인하세요.'})}});
server.listen(PORT,HOST,()=>console.log(`LOREFRAME http://${HOST}:${PORT}`));
