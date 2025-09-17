function $(sel){ return document.querySelector(sel); }

function setLoggedIn(v){
  if(v){ sessionStorage.setItem('loggedIn','1'); }
  else{ sessionStorage.removeItem('loggedIn'); }
}

function requireAuth(){
  if(sessionStorage.getItem('loggedIn')!=='1'){
    window.location.href = 'login.html';
  }
}

async function loadFiles(){
  const res = await fetch('/api/files?_=' + Date.now());
  if(!res.ok){ throw new Error('Cannot load files'); }
  return res.json();
}

function readableSize(bytes){
  const units=['B','KB','MB','GB'];
  let i=0, n=bytes;
  while(n>=1024 && i<units.length-1){ n/=1024; i++; }
  return (i===0? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
}

function formatDate(ms){
  const d = new Date(ms);
  return d.toLocaleString();
}
