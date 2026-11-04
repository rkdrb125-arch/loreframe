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
const json=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))};
const parse=async(req)=>{let raw='';for await(const c of req){raw+=c;if(raw.length>1024*1024)throw Error('요청 크기 제한 초과')}return JSON.parse(raw||'{}')};
const token=()=>crypto.randomBytes(32).toString('base64url');
const cookie=(req)=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=').slice(0,2)).filter(x=>x.length===2));
const getUser=(req)=>{let t=cookie(req).lf_session;if(!t)return null;let row=db.prepare('SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(crypto.createHash('sha256').update(t).digest('hex'),Date.now());return row||null};
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
if(!p.startsWith('/api/'))return json(res,404,{error:'찾을 수 없습니다'});
if(p==='/api/me'&&method==='GET')return json(res,200,{user:getUser(req)});
if(p==='/api/register'&&method==='POST'){let b=await parse(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(!/^\S+@\S+\.\S+$/.test(email)||email.length>200||password.length<10||password.length>200)return json(res,400,{error:'이메일과 10자 이상 비밀번호가 필요합니다.'});if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return json(res,409,{error:'이미 등록된 이메일입니다.'});let salt=crypto.randomBytes(16).toString('hex'),id=crypto.randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,email,pwHash(password,salt),salt,Date.now());return login(id,email)}
if(p==='/api/login'&&method==='POST'){let b=await parse(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');let row=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!row||!crypto.timingSafeEqual(Buffer.from(pwHash(password,row.salt),'hex'),Buffer.from(row.hash,'hex')))return json(res,401,{error:'이메일 또는 비밀번호가 올바르지 않습니다.'});return login(row.id,row.email)}
function login(id,email){let t=token();db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(t).digest('hex'),id,Date.now()+7*86400000);res.setHeader('Set-Cookie',`lf_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`);return json(res,200,{user:{id,email}})}
let user=getUser(req);if(!user)return json(res,401,{error:'로그인이 필요합니다.'});
if(p==='/api/logout'&&method==='POST'){let t=cookie(req).lf_session;if(t)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(t).digest('hex'));res.setHeader('Set-Cookie','lf_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true})}
if(p==='/api/data'&&method==='GET'){let row=db.prepare('SELECT body,updated_at FROM documents WHERE user_id=?').get(user.id);return json(res,200,{data:row?JSON.parse(row.body):null,updatedAt:row?.updated_at||null})}
if(p==='/api/data'&&method==='PUT'){let b=await parse(req);if(!b||!Array.isArray(b.characters)||!Array.isArray(b.relations)||!Array.isArray(b.events))return json(res,400,{error:'데이터 형식이 올바르지 않습니다.'});let body=JSON.stringify(b);if(body.length>900000)return json(res,413,{error:'저장 용량을 초과했습니다.'});db.prepare('INSERT INTO documents VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at').run(user.id,body,Date.now());return json(res,200,{ok:true})}
if(p==='/api/providers'&&method==='GET'){let rows=db.prepare('SELECT provider,model FROM providers WHERE user_id=?').all(user.id);return json(res,200,{providers:rows})}
if(p==='/api/providers'&&method==='POST'){let b=await parse(req),provider=String(b.provider||''),model=String(b.model||'').trim(),key=String(b.key||'').trim();if(!models[provider]||!model||model.length>150||key.length<8||key.length>500)return json(res,400,{error:'제공업체, 모델 ID, API 키를 확인해 주세요.'});db.prepare('INSERT INTO providers VALUES(?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET model=excluded.model,key_cipher=excluded.key_cipher').run(user.id,provider,model,encrypt(key));return json(res,200,{ok:true})}
if(p==='/api/providers'&&method==='DELETE'){let provider=String(u.searchParams.get('provider')||'');db.prepare('DELETE FROM providers WHERE user_id=? AND provider=?').run(user.id,provider);return json(res,200,{ok:true})}
if(p==='/api/ai'&&method==='POST'){let now=Date.now(),r=rate.get(user.id)||[];r=r.filter(x=>now-x<60000);if(r.length>=12)return json(res,429,{error:'분당 최대 12회 요청할 수 있습니다.'});r.push(now);rate.set(user.id,r);let b=await parse(req),provider=String(b.provider||''),row=db.prepare('SELECT model,key_cipher FROM providers WHERE user_id=? AND provider=?').get(user.id,provider);if(!row)return json(res,400,{error:'먼저 AI 연결 설정에서 API 키를 저장하세요.'});let messages=b.messages;if(!Array.isArray(messages)||messages.length!==2||messages.some(x=>typeof x.content!=='string'||x.content.length>30000))return json(res,400,{error:'분석 요청 형식이 올바르지 않습니다.'});let result=await inference(provider,decrypt(row.key_cipher),row.model,messages);return json(res,200,{text:result})}
return json(res,404,{error:'지원하지 않는 요청입니다.'});
}catch(e){console.error(e.message);return json(res,500,{error:e.message==='요청 크기 제한 초과'?e.message:'요청 처리 중 오류가 발생했습니다. 서버 로그를 확인하세요.'})}});
server.listen(PORT,HOST,()=>console.log(`LOREFRAME http://${HOST}:${PORT}`));
