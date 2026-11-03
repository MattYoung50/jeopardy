#pragma once
// All dynamic text (SSIDs) is escaped before insertion. Passwords are never rendered.
constexpr const char* PAGE_START = R"HTML(<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jeopardy Buzzer Setup</title><style>
body{font:18px system-ui;max-width:560px;margin:32px auto;padding:0 20px;background:#101b40;color:white}input,select,button{box-sizing:border-box;width:100%;font:inherit;margin:8px 0 20px;padding:12px;border-radius:6px}button{background:#ffdc65;color:#101b40;border:0;font-weight:700}button:disabled{opacity:.5}label{display:block}li{margin:12px 0}small{line-height:1.5;display:block}a{color:#ffdc65}</style></head><body><h1>Jeopardy Buzzer Setup</h1>)HTML";
constexpr const char* PAGE_SCRIPT = R"HTML(<script>
async function refresh(){try{const r=await fetch('/status',{cache:'no-store'});if(!r.ok)return;const s=await r.json();for(const d of s.devices){document.getElementById(d.color).textContent=d.color[0].toUpperCase()+d.color.slice(1)+': '+(d.released?'Ready to join home Wi-Fi':d.saved?'Settings saved':d.seen?'Receiving settings…':'Waiting—hold its button at startup');}document.getElementById('finish').disabled=!s.allSaved||s.releasing;document.getElementById('save').disabled=s.releasing;if(s.releasing)document.getElementById('message').textContent='Setup complete. Buzzers are joining home Wi-Fi. Reconnect this phone to your home network.';}catch{} }
refresh();setInterval(refresh,1000);
</script></body></html>)HTML";
