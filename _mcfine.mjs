// Same zero-edge MC, but with the step size driven DOWN until the add no longer
// gets a fill better than the prevailing price. If the +5.6pp at zero drift was
// a discretisation artifact it must decay toward zero as the step shrinks.
import { resolveRules } from "./src/challenge.mjs";
const WIN=21;
const R=resolveRules({circuitBreaker:500,dailyProfitStop:750});
const RF=Math.sqrt(8/Math.PI);
function mul(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);
  t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};}
let spare=null;
function gauss(rnd){ if(spare!==null){const s=spare;spare=null;return s;}
  let u=0,v=0;while(u===0)u=rnd();while(v===0)v=rnd();
  const r=Math.sqrt(-2*Math.log(u)); spare=r*Math.sin(2*Math.PI*v); return r*Math.cos(2*Math.PI*v);}
function trade(rnd,atr,drift,first,trig,winBars,K){
  const sBar=atr/RF, sStep=sBar/Math.sqrt(K), dStep=drift*atr/K, var_=sStep*sStep;
  const tp=1.75*atr, sl=Math.min(5*atr,1000/16);
  const t=trig*atr;
  let x=0,q=first,cost=0,added=first>=8,steps=0,bar=0;
  for(;;){
    const x0=x; x+=dStep+sStep*gauss(rnd); steps++;
    if(steps%K===0) bar++;
    if(x<=-sl) return {pnl:(-sl*q-cost)*2,q};
    if(x>=tp)  return {pnl:(tp*q-cost)*2,q};
    if(Math.exp(-2*(tp-x0)*(tp-x)/var_)>rnd()) return {pnl:(tp*q-cost)*2,q};
    if(Math.exp(-2*(x0+sl)*(x+sl)/var_)>rnd()) return {pnl:(-sl*q-cost)*2,q};
    if(!added&&bar<=winBars&&x>=t){ const a=8-q; cost+=t*a; q+=a; added=true; }
    if(bar>200) return {pnl:(x*q-cost)*2,q};
  }
}
function ev(d){let c=0,pk=0,lk=false,md=-1e18;
  for(const v of d){c+=v;if(v>md)md=v;const fl=lk?0:pk-R.trailingDD;
    if(c<=fl)return 0; if(c>pk)pk=c; if(R.lockAtBreakeven&&!lk&&pk>=R.trailingDD)lk=true;
    if(c>=R.profitTarget&&md<=0.5*c)return 1;} return 0;}
function run(drift,first,trig,K,draws,seed){
  const rnd=mul(seed); let pass=0,sum=0,n=0;
  for(let k=0;k<draws;k++){
    const days=[];
    for(let d=0;d<WIN;d++){ let p=0;
      for(let t2=0;t2<2;t2++){
        if(p>=R.dailyProfitStop||p<=-R.circuitBreaker) break;
        const r=trade(rnd,20,drift,first,trig,20,K);
        const net=r.pnl-0.75*2*r.q; p+=net; sum+=net; n++; }
      days.push(p); }
    pass+=ev(days);
  }
  return {pass:100*pass/draws, exp:sum/n};
}
const sBar=20/RF;
console.log(`\n  STEP-SIZE CONVERGENCE at ZERO drift. Trigger 0.15xATR = 3.0 points.`);
console.log(`  If the gain is a discretisation artifact it must vanish as the step shrinks.\n`);
console.log("   K      step(pts)  step/trigger   base $/tr   2+6 $/tr    base pass   2+6 pass   delta");
for(const [K,draws] of [[12,20000],[50,12000],[200,6000],[800,2500],[3200,900]]){
  const step=sBar/Math.sqrt(K);
  const b=run(0,8,0,K,draws,11);
  const s=run(0,2,0.15,K,draws,11);
  console.log(`   ${String(K).padStart(5)}  ${step.toFixed(2).padStart(9)}  ${(step/3).toFixed(2).padStart(12)}   `+
    `${("$"+b.exp.toFixed(2)).padStart(9)}  ${("$"+s.exp.toFixed(2)).padStart(9)}   ${b.pass.toFixed(1).padStart(8)}%  ${s.pass.toFixed(1).padStart(8)}%  `+
    `${((s.pass-b.pass>=0?"+":"")+(s.pass-b.pass).toFixed(1)).padStart(6)}pp`);
}
console.log(`\n  Same at the backtest-implied edge (drift 0.0069):`);
console.log("   K      step(pts)   base $/tr   2+6 $/tr    base pass   2+6 pass   delta");
for(const [K,draws] of [[200,6000],[800,2500],[3200,900]]){
  const step=sBar/Math.sqrt(K);
  const b=run(0.0069,8,0,K,draws,21);
  const s=run(0.0069,2,0.15,K,draws,21);
  console.log(`   ${String(K).padStart(5)}  ${step.toFixed(2).padStart(9)}   ${("$"+b.exp.toFixed(2)).padStart(9)}  ${("$"+s.exp.toFixed(2)).padStart(9)}   `+
    `${b.pass.toFixed(1).padStart(8)}%  ${s.pass.toFixed(1).padStart(8)}%  ${((s.pass-b.pass>=0?"+":"")+(s.pass-b.pass).toFixed(1)).padStart(6)}pp`);
}
