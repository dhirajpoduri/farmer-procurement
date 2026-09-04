
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "db.json");
const FEE = 20;

function now(){ return Date.now(); }
function id(prefix){ return `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`; }
function dateISO(d=new Date()){ return d.toISOString().slice(0,10); }
function timeToMin(t){ const [h,m]=t.split(":").map(Number); return h*60+m; }
function fail(message,status=400,extra={}){ const e=new Error(message); e.status=status; e.extra=extra; throw e; }

const defaultDb = {
  farmers: [],
  employees: [],
  centres: [
    {id:"C1",name:"Sangareddy APMC Yard",district:"Sangareddy",location:"Market Road, Sangareddy",distance_km:9,daily_capacity:500,status:"operational"},
    {id:"C2",name:"Patancheru Procurement Center",district:"Sangareddy",location:"Industrial Area, Patancheru",distance_km:14,daily_capacity:400,status:"operational"},
    {id:"C3",name:"Zaheerabad Grain Market",district:"Sangareddy",location:"Highway Junction, Zaheerabad",distance_km:22,daily_capacity:450,status:"operational"}
  ],
  slots: [],
  bookings: [],
  payments: [],
  cancellations: [],
  procurement: [],
  notifications: [],
  rates: [],
  sessions: {}
};

function seedSlots(db){
  if(db.slots.length) return;
  const today=dateISO();
  const defs=[
    ["C1","09:00","09:30",40],["C1","10:00","10:30",40],["C1","11:30","12:00",40],
    ["C1","14:00","14:30",40],["C1","15:30","16:00",40],["C1","17:00","17:30",40],
    ["C2","09:00","10:00",50],["C2","10:30","11:30",50],["C2","14:00","15:00",50],
    ["C3","10:00","11:00",60],["C3","11:30","12:30",60],["C3","15:00","16:00",60]
  ];
  defs.forEach((x,i)=>db.slots.push({id:`S${i+1}`,centre_id:x[0],date:today,start_time:x[1],end_time:x[2],capacity:x[3],booked_quantity:0,status:"open",delay_minutes:0,created_at:now()}));
}
function seedRates(db){
  if(!Array.isArray(db.rates)) db.rates=[];
  const today=dateISO();
  const defaults={Paddy:2300,Wheat:2500,Maize:2100,Cotton:7000};
  db.centres.forEach(c=>Object.entries(defaults).forEach(([crop,rate])=>{
    if(!db.rates.some(r=>r.centre_id===c.id&&r.date===today&&r.crop===crop)) db.rates.push({id:id("RATE"),centre_id:c.id,date:today,crop,rate_per_quintal:rate,updated_at:now(),updated_by:"SYSTEM"});
  }));
}
function rateFor(centreId,date,crop){ return db.rates.find(r=>r.centre_id===centreId&&r.date===date&&r.crop===crop); }

function load(){
  try{
    if(fs.existsSync(DATA_FILE)){
      const db=JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
      seedSlots(db); seedRates(db); persist(db); return db;
    }
  }catch(e){ console.error("DB load error",e); }
  const db=JSON.parse(JSON.stringify(defaultDb)); seedSlots(db); seedRates(db); persist(db); return db;
}
function persist(db){
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  fs.writeFileSync(DATA_FILE,JSON.stringify(db,null,2));
}
const db=load();

function json(res,status,body){
  const data=JSON.stringify(body);
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS"});
  res.end(data);
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let s="";
    req.on("data",c=>{s+=c;if(s.length>1e6) reject(fail("Request too large",413));});
    req.on("end",()=>{if(!s)return resolve({});try{resolve(JSON.parse(s));}catch(e){reject(fail("Invalid JSON",400));}});
    req.on("error",reject);
  });
}
function tokenFor(user){ const token=crypto.randomBytes(24).toString("hex"); db.sessions[token]={...user,created_at:now()}; persist(db); return token; }
function auth(req, roles){
  const h=req.headers.authorization||"";
  const token=h.startsWith("Bearer ")?h.slice(7):"";
  const session=db.sessions[token];
  if(!session) fail("Session expired. Please sign in again.",401);
  if(roles && !roles.includes(session.role)) fail("You are not authorized for this action.",403);
  return session;
}
function centre(id){ return db.centres.find(c=>c.id===id); }
function slot(id){ return db.slots.find(s=>s.id===id); }
function remaining(s){ return s.capacity-s.booked_quantity; }
function bookingView(b){
  const s=slot(b.slot_id), c=centre(b.centre_id), p=db.payments.find(x=>x.booking_id===b.id), r=rateFor(b.centre_id,b.booking_date,b.crop);
  const active=["BOOKED","CHECKED_IN","IN_PROGRESS"].includes(b.status);
  const ahead=db.bookings.filter(x=>x.centre_id===b.centre_id&&x.booking_date===b.booking_date&&x.id!==b.id&&x.created_at<b.created_at&&["BOOKED","CHECKED_IN","IN_PROGRESS"].includes(x.status)).length;
  const eta=Math.max(0,ahead*10+(s?.delay_minutes||0));
  return {...b,centre_name:c?.name,slot_start:s?.start_time,slot_end:s?.end_time,remaining_capacity:s?remaining(s):0,payment:p||null,rate:r?.rate_per_quintal??null,rate_date:r?.date??null,weight_quintals:b.weight_quintals??null,total_amount:b.total_amount??null,eta_minutes:active?eta:null,delay_minutes:s?.delay_minutes||0,tokens_ahead:ahead};
}
function validateSlotWindow(date,start,end,excludeId=null){
  if(!/^\d{2}:\d{2}$/.test(start)||!/^\d{2}:\d{2}$/.test(end)) fail("Use valid 24-hour times.");
  if(timeToMin(start)>=timeToMin(end)) fail("Slot end time must be after start time.");
  const overlap=db.slots.find(s=>s.date===date&&s.id!==excludeId&&s.status!=="closed"&&timeToMin(start)<timeToMin(s.end_time)&&timeToMin(end)>timeToMin(s.start_time));
  if(overlap) fail(`Time overlaps existing slot ${overlap.start_time}–${overlap.end_time}.`,409,{conflicting_slot_id:overlap.id});
}
function createBooking(user,b){
  const s=slot(b.slot_id);
  if(!s||s.centre_id!==b.centre_id) fail("Selected slot is not available.",404);
  if(s.date!==b.booking_date) fail("Slot date does not match booking date.",409);
  if(s.status!=="open") fail("This slot is closed.",409);
  const qty=Number(b.declared_quantity);
  if(!Number.isFinite(qty)||qty<=0) fail("Enter a valid produce quantity.");
  if(remaining(s)<qty) fail("Not enough capacity in this slot.",409,{remaining_capacity:remaining(s)});
  const duplicate=db.bookings.find(x=>x.farmer_id===user.id&&x.slot_id===s.id&&["PENDING_PAYMENT","BOOKED","CHECKED_IN","IN_PROGRESS"].includes(x.status));
  if(duplicate) fail("You already have a booking for this slot.",409);
  // Prevent a farmer from holding overlapping active slots on the same centre/date.
  const conflict=db.bookings.find(x=>x.farmer_id===user.id&&x.centre_id===s.centre_id&&x.booking_date===s.date&&x.id!==duplicate?.id&&["PENDING_PAYMENT","BOOKED","CHECKED_IN","IN_PROGRESS"].includes(x.status)&&timeToMin(s.start_time)<timeToMin(x.slot_end)&&timeToMin(s.end_time)>timeToMin(x.slot_start));
  if(conflict) fail("This booking overlaps another active booking you already have.",409,{conflicting_booking_id:conflict.id});
  s.booked_quantity+=qty;
  const booking={id:id("BKG"),farmer_id:user.id,centre_id:s.centre_id,slot_id:s.id,booking_date:s.date,slot_start:s.start_time,slot_end:s.end_time,slot_label:`${s.start_time} – ${s.end_time}`,crop:String(b.crop||"Paddy"),declared_quantity:qty,token_number:`${String.fromCharCode(65+db.centres.findIndex(c=>c.id===s.centre_id))}${100+db.bookings.filter(x=>x.centre_id===s.centre_id&&x.booking_date===s.date).length+1}`,status:"PENDING_PAYMENT",payment_status:"UNPAID",created_at:now()};
  db.bookings.push(booking); persist(db); return bookingView(booking);
}

function route(req,res){
  if(req.method==="OPTIONS") return json(res,204,{});
  const u=new URL(req.url,`http://${req.headers.host}`);
  const p=u.pathname;
  const method=req.method;
  Promise.resolve().then(async()=>{
    if(method==="POST"&&p==="/api/auth/register"){
      const b=await readBody(req);
      if(!b.name||!b.phone||!b.password) fail("Name, phone and password are required.");
      if(!/^\d{10}$/.test(String(b.phone))) fail("Phone number must be 10 digits.");
      if(String(b.password).length<4) fail("Password must be at least 4 characters.");
      if(db.farmers.some(f=>f.phone===b.phone)) fail("Phone number is already registered.",409);
      const f={id:id("FAR"),name:b.name.trim(),phone:b.phone.trim(),password:b.password,language:b.language||"en",district:b.district||"",pincode:b.pincode||"",created_at:now()};
      db.farmers.push(f); persist(db);
      const token=tokenFor({id:f.id,role:"farmer",name:f.name,phone:f.phone});
      return json(res,201,{user:{...f,password:undefined},token});
    }
    if(method==="POST"&&p==="/api/auth/login"){
      const b=await readBody(req);
      if(!/^\d{10}$/.test(String(b.phone||""))||!b.password) fail("Enter a valid mobile number and password.",400);
      const u=db.farmers.find(x=>x.phone===String(b.phone)&&x.password===b.password);
      if(!u) fail("Invalid mobile number or password. Please check your registered farmer account.",401);
      const token=tokenFor({id:u.id,role:"farmer",name:u.name,phone:u.phone});
      return json(res,200,{user:{...u,password:undefined},token});
    }
    const session=auth(req,["farmer"]);
    if(method==="GET"&&p==="/api/me") return json(res,200,{user:session});
    if(method==="PATCH"&&p==="/api/me"){ const b=await readBody(req); const list=db.farmers; const u=list.find(x=>x.id===session.id); if(!u) fail("User not found",404); if(b.language) u.language=b.language; persist(db); return json(res,200,{user:{...u,password:undefined}}); }
    if(method==="GET"&&p==="/api/centres") return json(res,200,db.centres);
    if(method==="GET"&&p==="/api/rates"){
      const centreId=u.searchParams.get("centre_id"), date=u.searchParams.get("date")||dateISO(), crop=u.searchParams.get("crop");
      return json(res,200,db.rates.filter(r=>(!centreId||r.centre_id===centreId)&&r.date===date&&(!crop||r.crop===crop)));
    }
    if(method==="GET"&&p==="/api/slots"){
      const centreId=u.searchParams.get("centre_id"), date=u.searchParams.get("date")||dateISO();
      const arr=db.slots.filter(s=>(!centreId||s.centre_id===centreId)&&s.date===date).map(s=>({...s,remaining:remaining(s)}));
      return json(res,200,arr);
    }
    if(method==="POST"&&p==="/api/bookings"){
      if(session.role!=="farmer") fail("Farmer access required.",403);
      const b=await readBody(req); const out=createBooking(session,b); return json(res,201,out);
    }
    const bm=p.match(/^\/api\/bookings\/([^/]+)$/);
    if(method==="GET"&&bm){
      const b=db.bookings.find(x=>x.id===bm[1]); if(!b) fail("Booking not found.",404);
      if(session.role==="farmer"&&b.farmer_id!==session.id) fail("Not allowed.",403);
      return json(res,200,bookingView(b));
    }
    const cm=p.match(/^\/api\/bookings\/([^/]+)\/cancel$/);
    if(method==="POST"&&cm){
      const b=db.bookings.find(x=>x.id===cm[1]); if(!b) fail("Booking not found.",404);
      if(session.role==="farmer"&&b.farmer_id!==session.id) fail("Not allowed.",403);
      if(b.status!=="BOOKED") fail(`Booking cannot be cancelled in status ${b.status}.`,409);
      const body=await readBody(req); if(!String(body.reason||"").trim()) fail("Please select a cancellation reason.");
      b.status="CANCELLED"; b.cancelled_at=now(); b.cancel_reason=body.reason;
      const s=slot(b.slot_id); if(s)s.booked_quantity=Math.max(0,s.booked_quantity-b.declared_quantity);
      db.cancellations.push({id:id("CAN"),booking_id:b.id,reason:body.reason,cancelled_by:session.role,cancelled_at:now()}); persist(db);
      return json(res,200,{booking:bookingView(b)});
    }
    const pm=p.match(/^\/api\/payments\/advance$/);
    if(method==="POST"&&pm){
      if(session.role!=="farmer") fail("Farmer access required.",403);
      const b=await readBody(req); const booking=db.bookings.find(x=>x.id===b.booking_id);
      if(!booking||booking.farmer_id!==session.id) fail("Booking not found.",404);
      if(booking.status!=="PENDING_PAYMENT") fail("Payment is not pending for this booking.",409);
      if(Number(b.amount)!==FEE) fail(`Booking fee must be ₹${FEE}.`,400);
      if(db.payments.some(p=>p.booking_id===booking.id&&p.status==="PAID")) fail("Payment already completed.",409);
      const payment={id:id("PAY"),booking_id:booking.id,farmer_id:session.id,amount:FEE,method:b.method||"UPI",transaction_id:id("TXN"),status:"PAID",paid_at:now()};
      db.payments.push(payment); booking.payment_status="PAID"; booking.status="BOOKED"; persist(db);
      return json(res,200,{booking:bookingView(booking),payment});
    }
    if(method==="GET"&&p==="/api/farmer/bookings"){
      if(session.role!=="farmer") fail("Farmer access required.",403);
      return json(res,200,db.bookings.filter(b=>b.farmer_id===session.id).sort((a,b)=>b.created_at-a.created_at).map(bookingView));
    }
    return json(res,404,{error:"Route not found"});
  }).catch(e=>json(res,e.status||500,{error:e.message||"Internal server error",...(e.extra||{})}));
}

function staticFile(req,res){
  let p;
  try{ p=decodeURIComponent(new URL(req.url,`http://${req.headers.host}`).pathname); }catch(e){return json(res,400,{error:"Bad URL"});}
  if(p==="/")p="/index.html";
  const full=path.normalize(path.join(PUBLIC,p));
  if(!full.startsWith(PUBLIC))return json(res,403,{error:"Forbidden"});
  fs.readFile(full,(err,data)=>{
    if(err)return json(res,404,{error:"File not found"});
    const ext=path.extname(full); const types={".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8"};
    res.writeHead(200,{"Content-Type":types[ext]||"text/plain; charset=utf-8","Cache-Control":"no-store"});res.end(data);
  });
}
http.createServer((req,res)=>{
  if(req.url.startsWith("/api/")) return route(req,res);
  if(req.method!=="GET") return json(res,405,{error:"Method not allowed"});
  staticFile(req,res);
}).listen(PORT,()=>console.log(`KisanDwaar running at http://localhost:${PORT}`));
