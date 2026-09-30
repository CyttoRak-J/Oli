/** The internal video page (bare <video>, quality list, repeat, speed, volume, download panel), shared by the PC and the phone. */

/** A single video stream for the internal video window. */
export interface VideoQualityStream {
  height: number;
  url: string;
  /** HLS manifest (played with hls.js) vs a direct media URL. */
  hls: boolean;
  /** True when the stream is video-only DASH and needs the paired audio URL. */
  videoOnly: boolean;
}

/** Per-video quality set: video streams by height + the best audio stream. */
export interface VideoQualitySet {
  streams: VideoQualityStream[];
  /** Best audio stream (m4a/AAC) to pair with video-only DASH; null when all streams are muxed. */
  audioUrl: string | null;
  /** True when this set was produced by a live yt-dlp run (not the cache). */
  fresh?: boolean;
}

/** Reads yt-dlp's `-j` output into the qualities the video page offers; null when it cannot be read. */
export function parseVideoQualities(stdout: string): VideoQualitySet | null {
  try {
    const info = JSON.parse(stdout) as {
      formats?: Array<{
        height?: number;
        url?: string;
        vcodec?: string;
        acodec?: string;
        ext?: string;
        protocol?: string;
      }>;
    };
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const bestVideo = new Map<
      number,
      {
        height: number;
        url: string;
        score: number;
        hls: boolean;
        videoOnly: boolean;
      }
    >();
    let audioUrl: string | null = null;
    let audioScore = -1;
    for (const fmt of formats) {
      const url = fmt.url;
      if (!url) continue;
      const isVideo = Boolean(fmt.vcodec && fmt.vcodec !== "none");
      const hasAudio = Boolean(fmt.acodec && fmt.acodec !== "none");
      const hls =
        (fmt.protocol && fmt.protocol.startsWith("m3u8")) ||
        /hls_playlist|\.m3u8(?:\?|$)/.test(url);
      if (isVideo && fmt.height) {
        // Video streams: muxed (with audio) or video-only DASH.
        const isDirect = !hls;
        const score =
          (isDirect ? 16 : 4) +
          (fmt.ext === "mp4" ? 4 : 0) +
          (fmt.vcodec && fmt.vcodec.startsWith("avc1") ? 2 : 0);
        const prev = bestVideo.get(fmt.height);
        if (!prev || score > prev.score) {
          bestVideo.set(fmt.height, {
            height: fmt.height,
            url,
            score,
            hls,
            videoOnly: !hasAudio,
          });
        }
      } else if (!isVideo && hasAudio) {
        // Audio-only streams: the pairing audio for video-only DASH.
        // MP4/AAC is what Chromium actually plays (WebM/Opus URLs from
        // the web_embedded player are rejected with NotSupportedError).
        const isDirect = !hls;
        const score =
          (isDirect ? 16 : 4) +
          (fmt.ext === "m4a" ? 6 : fmt.ext === "webm" ? 3 : 1) +
          (fmt.acodec === "aac" ? 4 : fmt.acodec === "opus" ? 2 : 0);
        if (score > audioScore) {
          audioScore = score;
          audioUrl = url;
        }
      }
    }
    return {
      streams: [...bestVideo.values()]
        .sort((a, b) => b.height - a.height)
        .map(({ height, url, hls, videoOnly }) => ({
          height,
          url,
          hls,
          videoOnly,
        })),
      audioUrl,
    };
  } catch {
    return null;
  }
}

/** Builds a self-contained page with a bare <video>, quality selector and repeat.
 * Video-only DASH streams are paired with the best audio stream in a hidden
 * <audio> element so 1080p+ videos actually have sound. A download panel
 * starts a merged video+audio download (shown in the app's Downloads list). */
export function buildVideoPage(
  set: VideoQualitySet,
  videoId: string,
  hlsTag: string,
): string {
  const labeled = set.streams.map((s) => ({
    url: s.url,
    hls: s.hls,
    audio: s.videoOnly ? set.audioUrl : null,
    label: s.height > 0 ? `${s.height}p` : "Best",
    height: s.height,
  }));
  const json = JSON.stringify(labeled).replace(/</g, "\\u003c");
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    hlsTag +
    `<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}` +
    `video{width:100vw;height:100vh;display:block;object-fit:contain;background:#000}` +
    `#qbar{position:fixed;top:10px;right:10px;z-index:10;display:flex;align-items:center;gap:6px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:4px 6px;font:12px system-ui;color:#fff}` +
    `#qbar select{background:rgba(0,0,0,.7);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:2px 4px;font-size:12px;outline:none}` +
    `#curq{min-width:34px;text-align:center;font-variant-numeric:tabular-nums;color:#ffd54a;font-weight:600}` +
    `#repeat{background:transparent;border:1px solid rgba(255,255,255,.3);border-radius:6px;color:#fff;padding:2px 8px;font-size:12px;cursor:pointer}` +
    `#repeat.active{background:rgba(255,255,255,.28);border-color:#fff}` +
    `#dlbtn{cursor:pointer;background:transparent;border:1px solid rgba(255,255,255,.3);border-radius:6px;color:#fff;padding:2px 9px;font-size:13px;line-height:1.3}` +
    `#dlbtn:hover{background:rgba(255,255,255,.18)}` +
    `#vol{width:80px;accent-color:#ffd54a;cursor:pointer}` +
    `#dlp{display:none;position:fixed;inset:0;z-index:20;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}` +
    `#dlbox{width:min(400px,90vw);background:#181818;border:1px solid rgba(255,255,255,.22);border-radius:12px;padding:16px;font:13px system-ui;color:#eee;display:flex;flex-direction:column;gap:10px}` +
    `#dlbox h3{margin:0 0 2px;font-size:14px;color:#fff}` +
    `#dlbox label{display:flex;justify-content:space-between;align-items:center;gap:10px;color:#bbb}` +
    `#dlbox select,#dlbox input{background:#111;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:4px 6px;font-size:12px;outline:none;min-width:0}` +
    `#dlf{flex:1}` +
    `#dlbox .row{display:flex;gap:6px}` +
    `#dlbox button{background:#ffd54a;color:#111;font-weight:700;border:0;border-radius:8px;padding:8px 10px;cursor:pointer;font-size:13px}` +
    `#dlbox button.sec{background:transparent;color:#ccc;border:1px solid rgba(255,255,255,.35);padding:4px 8px;font-weight:500}` +
    `#dlstatus{font-size:12px;color:#ffd54a;min-height:16px}` +
    `#errbox{display:none;position:fixed;inset:0;z-index:30;align-items:center;justify-content:center;background:rgba(0,0,0,.65);color:#fff;font:14px system-ui}` +
    `#errbox .eb2{background:#181818;border:1px solid rgba(255,255,255,.25);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px;text-align:center;min-width:260px}` +
    `#errbox button{background:#ffd54a;color:#111;font-weight:700;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px}` +
    `#errbox button.sec{background:transparent;color:#ccc;border:1px solid rgba(255,255,255,.35);font-weight:500}` +
    `</style></head><body>` +
    `<video id="v" controls playsinline autoplay></video>` +
    `<audio id="a" style="display:none" preload="auto"></audio>` +
    `<div id="qbar"><span id="curq">-</span> Quality <select id="q"></select><input id="vol" type="range" min="0" max="100" value="100" title="Volume"><select id="spd" title="Playback speed"></select><button id="dlbtn" title="Download video">⤓</button><button id="repeat" title="Repeat video">Repeat</button></div>` +
    `<div id="dlp"><div id="dlbox"><h3>Download video</h3>` +
    `<label>Video quality<select id="dlv"></select></label>` +
    `<label>Audio<select id="dla"><option value="best">Best audio</option><option value="m4a">MP4 (AAC)</option><option value="opus">Opus (WebM)</option></select></label>` +
    `<label>Folder<div class="row"><input id="dlf" placeholder="Default downloads folder"><button class="sec" id="dlpick">Choose…</button></div></label>` +
    `<div class="row"><button id="dlstart">Download video</button><span id="dlstatus"></span></div>` +
    `<div class="row"><button id="dlsong">Download song (tagged)</button><span id="dlsstatus" style="color:#8fe388"></span></div>` +
    `<div id="dlsng" style="font-size:11.5px;color:#bbb">Best audio only, with cover art + title/artist/album tags embedded.</div>` +
    `</div></div>` +
    `<div id="errbox"><div class="eb2"><div>Video playback failed</div><div id="errmsg" style="font-size:12px;color:#bbb">The stream could not be played.</div><div style="display:flex;gap:8px;justify-content:center"><button id="errretry">Retry</button><button id="errfallback" class="sec">Try backup stream</button></div></div></div>` +
    `<script>` +
    `const VID=${JSON.stringify(videoId)};` +
    `const ST=${json};const v=document.getElementById('v');const a=document.getElementById('a');const sel=document.getElementById('q');const curq=document.getElementById('curq');` +
    `const vol=document.getElementById('vol');const spd=document.getElementById('spd');` +
    `const dlbtn=document.getElementById('dlbtn');const dlp=document.getElementById('dlp');const dlv=document.getElementById('dlv');const dla=document.getElementById('dla');const dlf=document.getElementById('dlf');const dlstart=document.getElementById('dlstart');const dlstatus=document.getElementById('dlstatus');const dlsong=document.getElementById('dlsong');const dlsstatus=document.getElementById('dlsstatus');dlp.style.display='none';` +
    `const HLS=typeof self.Hls!=='undefined';let hls=null;` +
    `sel.style.display=ST.length>1?'':'none';` +
    `if(ST.length>1){ST.forEach((s,i)=>{const o=document.createElement('option');o.value=i;o.textContent=s.label;sel.appendChild(o)});}` +
    `[0.5,0.75,1,1.25,1.5,2].forEach(r=>{const o=document.createElement('option');o.value=String(r);o.textContent=r+'x';spd.appendChild(o)});spd.value='1';` +
    `let pos=0;let repeat=false;let switching=false;let firstPlay=true;let seq=0;` +
    `let autoRetried=false;let arTimer=null;` +
    `let stallIv=null;function clearStall(){if(stallIv){clearInterval(stallIv);stallIv=null}}` +
    `function armStall(){clearStall();const t0=Date.now();stallIv=setInterval(()=>{if(v.readyState>=3||(v.currentTime>0.2&&!v.paused)){clearStall();return}if(Date.now()-t0>8000){clearStall();stepDown()}},2000)}` +
    `function tearDown(){clearStall();if(hls){hls.destroy();hls=null}}` +
    `function whenHls(cb){if(typeof self.Hls!=='undefined'){cb()}else{let t=0;const iv=setInterval(()=>{t+=50;if(typeof self.Hls!=='undefined'||t>3000){clearInterval(iv);cb()}},50)}}` +
    `function setAudio(s){if(!s||!s.audio){a.removeAttribute('src');a.load();return}a.src=s.audio;a.load();a.volume=v.volume;a.muted=v.muted;a.playbackRate=v.playbackRate;if(!v.paused||v.autoplay)a.play().catch(()=>{})}` +
    `function setStream(i){const s=ST[i];if(!s)return;switching=true;setTimeout(()=>{switching=false},700);pos=v.currentTime||0;tearDown();curq.textContent=s.label;setAudio(s);` +
    `if(s.hls&&HLS&&!v.canPlayType('application/vnd.apple.mpegurl')){` +
    `let h=hls=new Hls({maxBufferLength:20});const buf=pos;h.loadSource(s.url);h.attachMedia(v);` +
    `h.on(Hls.Events.MANIFEST_PARSED,()=>{if(buf>0)v.currentTime=buf;v.play().catch(()=>{});armStall()});` +
    `h.on(Hls.Events.ERROR,(_e,d)=>{if(d&&d.fatal){tearDown();stepDown()}});` +
    `}else{` +
    `v.src=s.url;v.play().catch(()=>{});armStall();` +
    `}}` +
    `function stepDown(){const i=Number(sel.value);if(i<ST.length-1){sel.value=i+1;setStream(i+1)}else{showErr()}}` +
    `function showErr(){if(!autoRetried&&ST.length>0){autoRetried=true;arTimer=setTimeout(function(){if(v.readyState>=3||(v.currentTime>0.2&&!v.paused))return;setStream(0)},3000);return}document.getElementById('errbox').style.display='flex'}` +
    `function hideErr(){document.getElementById('errbox').style.display='none'}` +
    `dlbtn.addEventListener('click',()=>{const open=getComputedStyle(dlp).display!=='none';dlp.style.display=open?'none':'flex';if(dlv.options.length===0){const hs=[];ST.forEach(s=>{const h=Number(s.height);if(h>0&&hs.indexOf(h)<0)hs.push(h)});hs.sort((a,b)=>b-a);hs.forEach(h=>{const o=document.createElement('option');o.value=h;o.textContent=h+'p';dlv.appendChild(o)});const b=document.createElement('option');b.value='0';b.textContent='Best';dlv.insertBefore(b,dlv.firstChild);}});` +
    `dlp.addEventListener('click',(ev)=>{if(ev.target===dlp)dlp.style.display='none'});` +
    `document.getElementById('dlpick').addEventListener('click',async()=>{if(!window.cytto)return;const dir=await window.cytto.invoke('video:pick-folder');if(dir)dlf.value=dir;});` +
    `dlstart.addEventListener('click',async()=>{if(!window.cytto){dlstatus.textContent='Unavailable';return}const f=dlf.value.trim();const args=['video:download',VID,Number(dlv.value)||0,dla.value,f?f:null];dlstatus.textContent='Starting…';dlstart.disabled=true;try{const ok=await window.cytto.invoke.apply(null,args);dlstatus.textContent=ok?'Download started — see the Downloads page':"Couldn't start";}catch(e){dlstatus.textContent='Failed to start'}dlstart.disabled=false;setTimeout(()=>{dlstatus.textContent=''},5000)});` +
    `dlsong.addEventListener('click',async()=>{if(!window.cytto){dlsstatus.textContent='Unavailable';return}const f=dlf.value.trim();dlsstatus.textContent='Starting…';dlsong.disabled=true;try{const ok=await window.cytto.invoke.apply(null,['video:download-song',VID,dla.value,f?f:null]);dlsstatus.textContent=ok?'Song started — see the Downloads page':"Couldn't start";}catch(e){dlsstatus.textContent='Failed to start'}dlsong.disabled=false;setTimeout(()=>{dlsstatus.textContent=''},5000)});` +
    `vol.addEventListener('input',()=>{const x=Number(vol.value)/100;v.volume=x;if(a.src)a.volume=x;if(v.muted){v.muted=false}});` +
    `spd.addEventListener('change',()=>{const r=Number(spd.value);v.playbackRate=r;if(a.src)a.playbackRate=r});` +
    `v.addEventListener('loadedmetadata',()=>{if(pos>0){v.currentTime=pos}});` +
    `a.addEventListener('loadedmetadata',()=>{if(pos>0)a.currentTime=pos});` +
    `sel.addEventListener('change',()=>setStream(Number(sel.value)));` +
    `v.addEventListener('play',()=>{if(firstPlay){firstPlay=false;return}if(switching||v.muted)return;a.play().catch(()=>{});location.hash='#cyttos-video-play-'+(++seq)});` +
    `v.addEventListener('pause',()=>{if(!switching)a.pause()});` +
    `v.addEventListener('volumechange',()=>{vol.value=Math.round(v.volume*100);a.volume=v.volume;a.muted=v.muted;location.hash=(v.muted?'#cyttos-video-muted':'#cyttos-video-unmuted')+'-'+(++seq)});` +
    `v.addEventListener('ratechange',()=>{if(a.src)a.playbackRate=v.playbackRate});` +
    `v.addEventListener('seeked',()=>{if(a.src&&a.currentTime!==v.currentTime)a.currentTime=v.currentTime});` +
    `document.getElementById('repeat').addEventListener('click',()=>{repeat=!repeat;document.getElementById('repeat').classList.toggle('active',repeat);});` +
    `v.addEventListener('ended',()=>{a.pause();if(repeat){v.currentTime=0;v.play().catch(()=>{})}else{location.hash='#cyttos-video-ended-'+(++seq)}});` +
    `a.addEventListener('ended',()=>{if(!a.src)return;if(repeat){a.currentTime=0;a.play().catch(()=>{});if(v.ended||v.currentTime>=v.duration-0.3){v.currentTime=0;v.play().catch(()=>{})}}else{v.pause();if(!v.ended)location.hash='#cyttos-video-ended-'+(++seq)}});` +
    `v.addEventListener('error',stepDown);v.addEventListener('playing',function(){clearStall();if(arTimer){clearTimeout(arTimer);arTimer=null}});` +
    `if(ST.length>0){whenHls(function(){setStream(0)})}else{document.getElementById('errmsg').textContent='This video could not be loaded. Retry, or use the backup stream.';showErr()}` +
    `document.getElementById('errretry').addEventListener('click',()=>{hideErr();if(ST.length>0){setStream(0)}else if(window.cytto){window.cytto.invoke('video:retry',VID)}});` +
    `document.getElementById('errfallback').addEventListener('click',async()=>{if(!window.cytto)return;hideErr();let u=null;try{u=await window.cytto.invoke('video:fallback-url',VID)}catch(e){}if(!u){showErr();return}ST[ST.length]={url:u,hls:false,audio:null,label:'Best',height:0};sel.style.display=ST.length>1?'':'none';if(sel.value===''&&sel.options.length<ST.length-1){sel.options.length=0;ST.forEach((s,i)=>{const o=document.createElement('option');o.value=i;o.textContent=s.label;sel.appendChild(o)});sel.value=String(ST.length-1)}setStream(ST.length-1)});` +
    `</script></body></html>`;
  return html;
}
