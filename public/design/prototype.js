// Entirely synthetic fixtures: no fetch, no API calls and no Modbus requests.
import {barChart,lineChart} from '../charts.js';
const $ = id => document.getElementById(id);
const demoDay = new Date(2026,0,15).setHours(0,0,0,0);
let selectedDay=0,period='days';
const format=n=>new Intl.NumberFormat('pt-BR',{maximumFractionDigits:1}).format(n);
const clock=ts=>new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
function charts() {
  const scale=selectedDay===0?1:0.91;
  const points=Array.from({length:57},(_,i)=>{
    const hour=5+i/4;
    const watts=Math.max(0,Math.sin((hour-6)/12*Math.PI))*5600*(0.94+Math.sin(i*0.8)*0.055)*scale;
    return [demoDay+hour*3_600_000,Math.round(watts)];
  }).filter(([ts])=>selectedDay<0 || ts<=demoDay+14.5*3_600_000);
  lineChart($('power-chart'),{points,xMin:demoDay+5*3_600_000,xMax:demoDay+20*3_600_000,gapMs:3_600_000,
    yFormat:w=>w>=1000?`${format(w/1000)}k`:format(w),tip:([ts,w])=>`<strong>${format(w/1000)} kW</strong>${clock(ts)}`,empty:'Sem dados demonstrativos.'});
  const count=period==='days'?15:period==='months'?12:5;
  const labels=period==='months'?['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']:null;
  const items=Array.from({length:count},(_,i)=>({label:labels?.[i]??String(period==='years'?2022+i:i+1),title:labels?.[i]??`${period==='years'?'Ano':'Dia'} ${period==='years'?2022+i:i+1}`,value:Math.round((period==='days'?22:period==='months'?540:6400)*(1+Math.sin(i*1.7)*0.2))}));
  barChart($('energy-chart'),{items,yFormat:format,valueFormat:n=>`${format(n)} kWh`,tip:item=>`<strong>${format(item.value)} kWh</strong>${item.title}`,empty:'Sem dados demonstrativos.'});
}
function openSystem() {
  if($('system-details')) { $('system-details').open=true;$('system-details').scrollIntoView({behavior:'smooth',block:'start'}); }
  else setSection('system');
}
function setSection(section) {
  $('overview-panel').hidden=section!=='overview';$('system-panel').hidden=section!=='system';
  for(const button of document.querySelectorAll('[data-section]'))button.setAttribute('aria-selected',String(button.dataset.section===section));
  if(section==='overview')requestAnimationFrame(charts);
}
for(const button of document.querySelectorAll('[data-section]'))button.onclick=()=>setSection(button.dataset.section);
for(const button of document.querySelectorAll('[data-period]'))button.onclick=()=>{
  period=button.dataset.period;
  for(const b of document.querySelectorAll('[data-period]'))b.setAttribute('aria-selected',String(b===button));
  $('energy-sub').textContent={days:'Geração diária',months:'Geração mensal',years:'Geração anual'}[period];charts();
};
$('previous-day').onclick=()=>{selectedDay=-1;$('sample-day').textContent='Ontem';$('next-day').disabled=false;charts()};
$('next-day').onclick=()=>{selectedDay=0;$('sample-day').textContent='Hoje';$('next-day').disabled=true;charts()};
const theme=$('theme');
try { theme.value=localStorage.getItem('solar-design-theme')??'auto'; } catch { }
const applyTheme=()=>{if(theme.value==='auto')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=theme.value;try{localStorage.setItem('solar-design-theme',theme.value)}catch{}};
theme.onchange=applyTheme;applyTheme();
$('condition').onchange=()=>{
  const selected=$('condition').value;
  const states={
    ok:{status:'Gerando',color:'var(--good)',power:'4,26',updated:'Entrada solar 4,51 kW · atualizado às 14:35',logger:'Acessível',web:'Acessível',modbus:'Respondendo',inverter:'Gerando',description:'Uma conexão reutilizada, com leitura a cada 5 min. Exemplo de comunicação normal.'},
    modbus:{status:'Sem leituras',color:'var(--warning)',power:'—',updated:'Última leitura às 14:35 · causa ainda não confirmada',logger:'Acessível',web:'Acessível',modbus:'Sem resposta',inverter:'Sem leitura recente',description:'O stick responde na rede, mas o Modbus está indisponível. Isso não confirma, sozinho, travamento ou repouso do inversor.'},
    asleep:{status:'Provável repouso',color:'var(--idle)',power:'0',updated:'Pouca luz · aguardando novas leituras',logger:'Sem resposta',web:'Sem resposta',modbus:'Sem resposta',inverter:'Provável repouso',description:'O horário e a baixa geração sugerem repouso. A recuperação será confirmada quando novas leituras chegarem.'},
    offline:{status:'Fora de rede',color:'var(--warning)',power:'—',updated:'Nenhuma resposta recente do equipamento',logger:'Inacessível',web:'Sem resposta',modbus:'Sem resposta',inverter:'Estado desconhecido',description:'Sem resposta de rede. Pode ser alimentação, endereço ou conectividade; não é possível afirmar que o inversor está desligado.'},
  };
  const s=states[selected];$('status-text').textContent=s.status;$('status').querySelector('.state-dot').style.background=s.color;
  $('sample-power').textContent=s.power;$('now-label').textContent=selected==='ok'?'Potência agora':'Última potência';$('sample-updated').textContent=s.updated;
  $('logger-state').textContent=s.logger;$('web-state').textContent=s.web;$('modbus-state').textContent=s.modbus;$('inverter-state').textContent=s.inverter;$('connection-description').textContent=s.description;
  document.querySelector('.hero .meter').hidden=selected!=='ok';
};
$('open-menu').onclick=()=>$('menu').showModal();
$('system-link').onclick=()=>{$('menu').close();openSystem()};
$('refresh-demo').onclick=()=>{
  $('menu').close();const toast=$('toast');toast.textContent='Atualizando demonstração…';toast.hidden=false;
  setTimeout(()=>{toast.textContent='Demonstração atualizada';setTimeout(()=>toast.hidden=true,1500)},650);
};
let timer;window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(charts,100)});
charts();
