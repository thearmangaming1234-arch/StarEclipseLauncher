let instances=[];
let newsItems=[];
let profiles=[];
let selectedProfileId=null;
let selectedInstanceFolder=null;
let pinnedInstanceFolders=[];
let sidebarOrder=['home','mods','profile','settings'];
let newsEnabled=true;
let newsRefreshTimer=null;
let noteSaveTimer=null;
let noteSelectionRange=null;
let removeProfileTarget=null;
let renameInstanceTarget=null;
let pageAnimationTimer=null;
let pageAnimationDuration=450;
const skinUrlRequests=new Map();

const animationDurations={fast:280,normal:450,relaxed:700,slow:1000,off:0};
const sidebarPageLabels={home:'Home',mods:'Mods',profile:'Profile',settings:'Settings'};

const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);

async function init(){
  const settings=await window.eclipse.settings.get();
  pinnedInstanceFolders=settings.pinnedInstances||[];
  $('#microsoftClientId').value=settings.microsoftClientId||'';
  applySettings(settings);
  renderProfiles(settings);
  instances=await window.eclipse.instances.list();
  selectedInstanceFolder=null;
  pinnedInstanceFolders=pinnedInstanceFolders.filter(folder=>instances.some(instance=>instance.folder===folder));
  renderInstances();
  renderQuick();
  $('#modInstance').innerHTML=instances.map(i=>`<option value="${escapeHtml(i.folder)}">${escapeHtml(i.name)}</option>`).join('');
  if(newsEnabled){
    await loadNews();
    startNewsRefresh();
  }
}

function applySettings(s){
  const name=s.profile?.name||'Steve';
  $('#accountName').textContent=name;
  const crown=name==='Arman_Legend'?'<svg class="name-crown" viewBox="0 0 20 18" aria-label="Crown" role="img"><path d="M2 6.5 5.2 9l2-5 2.8 4.2L12.8 4l2 5L18 6.5l-1.7 8H3.7L2 6.5Z"/><path d="M4.5 17h11"/></svg>':'';
  $('#heroName').innerHTML=escapeHtml(name)+crown;
  hydrateSkinHead($('#avatar'),s.profile?.id,name);
  if(s.backgroundUrl){
    setBackgroundImage(s.backgroundUrl);
  } else if(s.background) {
    const url = localFileUrl(s.background);
    setBackgroundImage(url);
  }
  $('#theme').value=s.theme||'dark';
  $('#animationSpeed').value=s.animationSpeed||'normal';
  syncCustomDropdown('animationSpeed');
  setAnimationSpeed(s.animationSpeed||'normal');
  $('#playAnimationSpeed').value=s.playAnimationSpeed||'relaxed';
  syncCustomDropdown('playAnimationSpeed');
  setPlayAnimationSpeed(s.playAnimationSpeed||'relaxed');
  newsEnabled=s.newsEnabled!==false;
  $('#newsEnabledToggle').checked=newsEnabled;
  $('#newsSection').hidden=!newsEnabled;
  applySidebarOrder(s.sidebarOrder||sidebarOrder);
  document.body.classList.toggle('light',s.theme==='light');
  if(s.profile?.status) updateStatusUI(s.profile.status);
}

function renderProfiles(settings){
  profiles=settings.profiles||[];
  selectedProfileId=settings.selectedProfileId||settings.profile?.id||null;
  $('#profileList').innerHTML=profiles.map(profile=>{
    const selected=profile.id===selectedProfileId;
    const isMicrosoft=profile.type==='microsoft';
    return `<button class="profile-choice${selected?' selected':''}" data-profile-id="${escapeHtml(profile.id)}" aria-pressed="${selected}">
      ${skinHeadMarkup(profile.name,`profile-avatar ${isMicrosoft?'microsoft':''}`)}
      <span class="profile-choice-copy"><b>${escapeHtml(profile.name)}</b><small>${isMicrosoft?'Microsoft account':'Offline profile'}</small></span>
      <span class="profile-choice-check">${selected?'✓':'›'}</span>
    </button>`;
  }).join('');
  $$('.profile-choice .skin-head').forEach((head,index)=>hydrateSkinHead(head,profiles[index]?.id,profiles[index]?.name));
  $$('.profile-choice').forEach(button=>button.onclick=async()=>{
    try{
      const updated=await window.eclipse.accounts.select(button.dataset.profileId);
      renderProfiles(updated);
      applySettings(updated);
    }catch(error){showAccountMessage(error.message,true);}
  });
  const selected=profiles.find(profile=>profile.id===selectedProfileId);
  $('#selectedProfileDetails').innerHTML=selected?`<div class="selected-profile-card">
    ${skinHeadMarkup(selected.name,`profile-avatar large ${selected.type==='microsoft'?'microsoft':''}`)}
    <div class="selected-profile-copy"><span class="tag">${selected.type==='microsoft'?'MICROSOFT ACCOUNT':'OFFLINE PROFILE'}</span><h2>${escapeHtml(selected.name)}</h2><p>${selected.type==='microsoft'?'This Microsoft account is selected for Minecraft launches.':'This local player profile is selected for Minecraft launches.'}</p></div>
    ${profiles.length>1?`<button class="remove-profile-button" id="removeSelectedProfile">Remove</button>`:''}
  </div>
  <div class="profile-tools-grid">
    <section class="profile-tool-card notes-card"><div class="profile-tool-heading"><div><h3>Account notes</h3><small>Saved with this profile on this device</small></div><span id="noteSaveState">Saved</span></div>
      <div class="note-toolbar" role="toolbar" aria-label="Format account note">
        <button type="button" data-note-command="bold" aria-label="Bold" title="Bold"><b>B</b></button>
        <button type="button" data-note-command="italic" aria-label="Italic" title="Italic"><i>I</i></button>
        <button type="button" data-note-command="underline" aria-label="Underline" title="Underline"><u>U</u></button>
        <label class="note-color-control" for="noteTextColor" title="Text color"><span>A</span><input type="color" id="noteTextColor" value="#d9c7ff" aria-label="Text color"></label>
      </div>
      <div id="profileNote" class="note-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Account notes" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off" data-placeholder="Keep a note for ${escapeHtml(selected.name)}…"></div>
    </section>
    <section class="profile-tool-card skin-card"><div class="profile-tool-heading"><div><h3>Skin viewer</h3><small>Ely.by and official Minecraft skins</small></div><button id="downloadSkin" class="skin-download-button" title="Download this skin" aria-label="Download this skin">↓</button></div>
      <div class="skin-viewer-content">${skinHeadMarkup(selected.name,'skin-viewer-head')}<div class="skin-texture-wrap"><span class="skin-texture-label">Full skin texture</span><div class="skin-texture-frame"><img id="skinTexturePreview" alt="${escapeHtml(selected.name)} Minecraft skin texture"><span id="skinMessage">Looking for this skin…</span></div></div></div>
    </section>
  </div>`:'';
  if(selected){
    const noteEditor=$('#profileNote');
    noteEditor.innerHTML=selected.noteFormat==='html-v1'
      ? sanitizeNoteHtml(selected.note||'')
      : plainTextToNoteHtml(selected.note||'');
    attachNoteEditor(noteEditor,selected.id);
    const head=$('#selectedProfileDetails .selected-profile-card .skin-head');
    const viewerHead=$('#selectedProfileDetails .skin-viewer-head');
    const texture=$('#skinTexturePreview');
    const message=$('#skinMessage');
    hydrateSkinHead(head,selected.id,selected.name);
    hydrateSkinHead(viewerHead,selected.id,selected.name,texture,message);
    $('#downloadSkin').onclick=async()=>{
      const button=$('#downloadSkin');
      button.disabled=true;
      message.textContent='Preparing skin download…';
      try{
        const savedPath=await window.eclipse.accounts.downloadSkin(selected.id);
        if(savedPath) message.textContent=`Skin saved to ${savedPath}`;
        else message.textContent='Download cancelled.';
      }catch(error){message.textContent=error.message;}
      finally{button.disabled=false;}
    };
  }
  $('#removeSelectedProfile')?.addEventListener('click',async()=>{
    showRemoveProfileDialog(selected);
  });
}

function plainTextToNoteHtml(value){
  return escapeHtml(value).replace(/\r\n|\r|\n/g,'<br>');
}

function sanitizeNoteHtml(value){
  const template=document.createElement('template');
  template.innerHTML=String(value||'');
  const allowed=new Set(['B','STRONG','I','EM','U','BR','DIV','P','SPAN','FONT']);
  const scrub=parent=>{
    [...parent.childNodes].forEach(node=>{
      if(node.nodeType===Node.TEXT_NODE)return;
      if(node.nodeType!==Node.ELEMENT_NODE){node.remove();return;}
      const tag=node.tagName;
      if(!allowed.has(tag)){
        node.remove();
        return;
      }
      const rawColor=node.style.color||node.getAttribute('color')||'';
      const cleanColor=CSS.supports('color',rawColor)?rawColor:'';
      const styles=[];
      if(cleanColor)styles.push(`color:${cleanColor}`);
      if(['bold','600','700','800','900'].includes(node.style.fontWeight))styles.push('font-weight:bold');
      if(node.style.fontStyle==='italic')styles.push('font-style:italic');
      if((node.style.textDecorationLine||node.style.textDecoration||'').includes('underline'))styles.push('text-decoration:underline');
      const replacement=tag==='FONT'?document.createElement('span'):node;
      if(replacement!==node){node.replaceWith(replacement);replacement.append(...node.childNodes);}
      [...replacement.attributes].forEach(attribute=>replacement.removeAttribute(attribute.name));
      if(styles.length)replacement.setAttribute('style',styles.join(';'));
      scrub(replacement);
    });
  };
  scrub(template.content);
  return template.innerHTML;
}

function saveNoteSelection(editor){
  const selection=window.getSelection();
  if(selection?.rangeCount&&editor.contains(selection.anchorNode))noteSelectionRange=selection.getRangeAt(0).cloneRange();
}

function restoreNoteSelection(editor){
  editor.focus();
  if(!noteSelectionRange)return;
  const selection=window.getSelection();
  selection.removeAllRanges();
  selection.addRange(noteSelectionRange);
}

function attachNoteEditor(editor,profileId){
  const status=$('#noteSaveState');
  editor.addEventListener('keyup',()=>saveNoteSelection(editor));
  editor.addEventListener('mouseup',()=>saveNoteSelection(editor));
  editor.addEventListener('paste',event=>{
    event.preventDefault();
    document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));
  });
  editor.addEventListener('input',()=>{
    saveNoteSelection(editor);
    status.textContent='Saving…';
    clearTimeout(noteSaveTimer);
    const note=sanitizeNoteHtml(editor.innerHTML);
    noteSaveTimer=setTimeout(async()=>{
      try{await window.eclipse.accounts.setNote(profileId,note);if(status.isConnected)status.textContent='Saved';}
      catch(error){if(status.isConnected)status.textContent='Could not save';showAccountMessage(error.message,true);}
    },450);
  });
  $$('[data-note-command]').forEach(button=>{
    button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',()=>{
      restoreNoteSelection(editor);
      document.execCommand('styleWithCSS',false,true);
      document.execCommand(button.dataset.noteCommand,false,null);
      saveNoteSelection(editor);
      editor.dispatchEvent(new Event('input',{bubbles:true}));
    });
  });
  const colorPicker=$('#noteTextColor');
  colorPicker.addEventListener('mousedown',()=>saveNoteSelection(editor));
  colorPicker.addEventListener('change',()=>{
    restoreNoteSelection(editor);
    document.execCommand('styleWithCSS',false,true);
    document.execCommand('foreColor',false,colorPicker.value);
    saveNoteSelection(editor);
    editor.dispatchEvent(new Event('input',{bubbles:true}));
  });
}

function showRemoveProfileDialog(profile){
  removeProfileTarget=profile;
  $('#removeProfileName').textContent=profile.name;
  $('#removeProfileError').hidden=true;
  $('#removeProfileError').textContent='';
  const overlay=$('#removeProfileDialog');
  overlay.hidden=false;
  $('#removeProfileCancel').focus();
}

function closeRemoveProfileDialog(){
  $('#removeProfileDialog').hidden=true;
  removeProfileTarget=null;
}

function showRenameInstanceDialog(instance){
  renameInstanceTarget=instance;
  $('#renameInstanceInput').value=instance.name||instance.folder;
  $('#renameInstanceError').hidden=true;
  $('#renameInstanceError').textContent='';
  $('#renameInstanceDialog').hidden=false;
  $('#renameInstanceInput').focus();
  $('#renameInstanceInput').select();
}

function closeRenameInstanceDialog(){
  $('#renameInstanceDialog').hidden=true;
  renameInstanceTarget=null;
}

function skinHeadMarkup(name,extraClass=''){
  const initial=escapeHtml((name||'?').slice(0,1).toUpperCase());
  return `<span class="skin-head ${extraClass}"><span class="skin-initial">${initial}</span><img class="skin-head-base" alt=""><img class="skin-head-hat" alt=""></span>`;
}

async function hydrateSkinHead(head,profileId,name,textureImage=null,statusMessage=null){
  if(!head||!profileId)return;
  try{
    let lookup=skinUrlRequests.get(profileId);
    if(!lookup){
      lookup=window.eclipse.accounts.skinUrl(profileId).finally(()=>skinUrlRequests.delete(profileId));
      skinUrlRequests.set(profileId,lookup);
    }
    const url=await lookup;
    if(!head.isConnected)return;
    if(!url)throw new Error(`No Ely.by or Minecraft skin found for ${name}.`);
    const base=head.querySelector('.skin-head-base');
    const hat=head.querySelector('.skin-head-hat');
    base.onload=()=>head.classList.add('has-skin');
    base.onerror=()=>head.classList.add('skin-missing');
    base.src=url;
    hat.src=url;
    if(textureImage){
      textureImage.onload=()=>{textureImage.classList.add('loaded');if(statusMessage)statusMessage.hidden=true;};
      textureImage.onerror=()=>{if(statusMessage)statusMessage.textContent=`No skin texture available for ${name}.`;};
      textureImage.src=url;
    }
  }catch(error){
    if(head.isConnected)head.classList.add('skin-missing');
    if(statusMessage)statusMessage.textContent=error.message;
  }
}

function showAccountMessage(message,isError=false){
  const node=$('#accountSetupMessage');
  node.textContent=message||'';
  node.classList.toggle('error',Boolean(isError));
}

function setAccountType(type){
  $$('[data-account-type]').forEach(button=>button.classList.toggle('active',button.dataset.accountType===type));
  $('#offlineAccountForm').hidden=type!=='offline';
  $('#microsoftAccountForm').hidden=type!=='microsoft';
  showAccountMessage('');
}

function localFileUrl(filePath){
  const normalized=String(filePath).replaceAll('\\','/');
  if(/^[A-Za-z]:\//.test(normalized)) return 'file:///'+encodeURI(normalized);
  if(normalized.startsWith('/')) return 'file://'+encodeURI(normalized);
  return normalized;
}

function setBackgroundImage(url){
  const hero=$('.hero');
  hero.style.setProperty('--eclipse-custom-background',`url("${url.replaceAll('"','%22')}")`);
  hero.classList.add('custom-background');
  $('#backgroundPreview').style.backgroundImage=`url("${url}")`;
}

function updateStatusUI(status){
  const safeStatus=['online','offline','dnd'].includes(status)?status:'online';
  const label={online:'Online',offline:'Offline',dnd:'Do Not Disturb'}[safeStatus];
  const dot=document.createElement('i');
  dot.className=`status-dot status-${safeStatus}`;
  dot.setAttribute('aria-hidden','true');
  $('#accountState').replaceChildren(dot,document.createTextNode(label));
}

function setAnimationSpeed(speed='normal'){
  pageAnimationDuration=animationDurations[speed]??animationDurations.normal;
  document.documentElement.style.setProperty('--page-animation-duration',`${pageAnimationDuration}ms`);
  document.documentElement.style.setProperty('--motion-transition-duration',`${speed==='off'?0:Math.round(pageAnimationDuration*.4)}ms`);
  return pageAnimationDuration;
}

function setPlayAnimationSpeed(speed='relaxed'){
  const duration=animationDurations[speed]??animationDurations.relaxed;
  document.documentElement.style.setProperty('--selected-play-duration',`${duration}ms`);
  return duration;
}

function applySidebarOrder(order){
  const pages=Object.keys(sidebarPageLabels);
  const requested=Array.isArray(order)?order.filter(page=>pages.includes(page)):[];
  sidebarOrder=[...new Set(requested),...pages.filter(page=>!requested.includes(page))];
  const nav=$('aside nav');
  sidebarOrder.forEach(page=>{
    const button=nav.querySelector(`[data-page="${page}"]`);
    if(button)nav.appendChild(button);
  });
  const list=$('#sidebarOrderList');
  if(!list)return;
  list.innerHTML=sidebarOrder.map((page,index)=>`<div class="sidebar-order-row"><span>${escapeHtml(sidebarPageLabels[page])}</span><div><button type="button" data-order-page="${page}" data-order-move="-1" aria-label="Move ${sidebarPageLabels[page]} up" title="Move up" ${index===0?'disabled':''}>↑</button><button type="button" data-order-page="${page}" data-order-move="1" aria-label="Move ${sidebarPageLabels[page]} down" title="Move down" ${index===sidebarOrder.length-1?'disabled':''}>↓</button></div></div>`).join('');
  $$('.sidebar-order-row button').forEach(button=>button.onclick=()=>moveSidebarPage(button.dataset.orderPage,Number(button.dataset.orderMove)));
}

async function moveSidebarPage(page,offset){
  const next=[...sidebarOrder];
  const from=next.indexOf(page);
  const to=from+offset;
  if(from<0||to<0||to>=next.length)return;
  [next[from],next[to]]=[next[to],next[from]];
  try{
    await window.eclipse.settings.set({sidebarOrder:next});
    applySidebarOrder(next);
  }catch(error){alert(`Could not save the sidebar order:\n${error.message}`);}
}

function startNewsRefresh(){
  clearInterval(newsRefreshTimer);
  newsRefreshTimer=window.setInterval(()=>{
    if(newsEnabled&&document.visibilityState==='visible')loadNews(true);
  },15*60*1000);
}

function syncCustomDropdown(selectId){
  const select=$('#'+selectId);
  const root=select?.closest('.custom-select');
  if(!root)return;
  const option=[...select.options].find(item=>item.value===select.value)||select.options[0];
  root.querySelector('.custom-select-value').textContent=option?.textContent||'';
  root.querySelectorAll('.custom-select-option').forEach(button=>{
    const selected=button.dataset.value===select.value;
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-selected',String(selected));
  });
}

function setupCustomDropdowns(){
  const roots=[...$$('.custom-select')];
  const close=root=>{
    root.classList.remove('open');
    root.querySelector('.custom-select-trigger').setAttribute('aria-expanded','false');
  };
  const open=(root,focusOption=false)=>{
    roots.forEach(other=>{if(other!==root)close(other);});
    root.classList.add('open');
    root.querySelector('.custom-select-trigger').setAttribute('aria-expanded','true');
    if(focusOption){
      const selected=root.querySelector('.custom-select-option.selected')||root.querySelector('.custom-select-option');
      selected?.focus();
    }
  };
  roots.forEach(root=>{
    const select=root.querySelector('select');
    const trigger=root.querySelector('.custom-select-trigger');
    const options=[...root.querySelectorAll('.custom-select-option')];
    syncCustomDropdown(select.id);
    trigger.onclick=()=>root.classList.contains('open')?close(root):open(root);
    trigger.onkeydown=event=>{
      if(['ArrowDown','ArrowUp','Enter',' '].includes(event.key)){
        event.preventDefault();
        open(root,true);
      }
    };
    options.forEach(option=>option.onclick=()=>{
      select.value=option.dataset.value;
      syncCustomDropdown(select.id);
      close(root);
      select.dispatchEvent(new Event('change',{bubbles:true}));
      trigger.focus();
    });
    root.querySelector('.custom-select-menu').onkeydown=event=>{
      const current=options.indexOf(event.target.closest('.custom-select-option'));
      let next=current;
      if(event.key==='Escape'){
        event.preventDefault();close(root);trigger.focus();return;
      }
      if(event.key==='ArrowDown')next=(current+1)%options.length;
      else if(event.key==='ArrowUp')next=(current-1+options.length)%options.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=options.length-1;
      else return;
      event.preventDefault();options[next].focus();
    };
  });
  document.addEventListener('click',event=>roots.forEach(root=>{
    if(!root.contains(event.target))close(root);
  }));
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape')roots.forEach(close);
  });
}

function renderInstances(){
  const q=$('#search').value.toLowerCase();
  let list=instances.filter(i=>(i.name||i.folder).toLowerCase().includes(q));
  const sort=$('#sort').value;
  list.sort((a,b)=>{
    if(sort==='name') return (a.name||'').localeCompare(b.name||'');
    if(sort==='version') return (a.version||'').localeCompare(b.version||'');
    return (b.lastPlayed||0)-(a.lastPlayed||0);
  });
  if(selectedInstanceFolder&&!instances.some(instance=>instance.folder===selectedInstanceFolder)) selectedInstanceFolder=null;
  $('#instances').innerHTML=list.map(i=>`
      <article class="instance${i.folder===selectedInstanceFolder?' selected':''}" data-folder="${escapeHtml(i.folder)}" role="group" tabindex="0" aria-label="${escapeHtml(i.name||i.folder)} instance">
      ${i.image?`<img src="${escapeHtml(i.image)}" alt="">`:''}
      <div class="instance-body">
        <div class="instance-heading"><h3><span class="instance-name-label">${escapeHtml(i.name||i.folder)}</span>${instanceIconMarkup(i)}</h3><span class="instance-actions"><button class="instance-pin${pinnedInstanceFolders.includes(i.folder)?' pinned':''}" type="button" aria-label="${pinnedInstanceFolders.includes(i.folder)?'Unpin':'Pin'} ${escapeHtml(i.name||i.folder)} in Quick Launch" title="${pinnedInstanceFolders.includes(i.folder)?'Unpin instance':'Pin to Quick Launch'}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5h6l-.7 3 2.2 2.2v1H8.5v4.8l-.5.8-.5-.8V8.7H3.5v-1l2.2-2.2L5 2.5Z"/></svg></button><button class="instance-rename" type="button" aria-label="Rename ${escapeHtml(i.name||i.folder)}" title="Rename instance"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m2.5 11.5-.7 3 3-.7 8.1-8.1a1.63 1.63 0 0 0-2.3-2.3l-8.1 8.1Z"/><path d="m9.8 4.3 2.3 2.3"/></svg></button></span></div>
        ${instanceMetaMarkup(i)}
      </div>
    </article>`).join('') || `<div class="panel">No instances found.</div>`;
  $$('.instance[data-folder]').forEach(card=>{
    card.onclick=event=>{if(!event.target.closest('.instance-actions'))selectInstance(card.dataset.folder);};
    card.onkeydown=event=>{if(event.target===card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();selectInstance(card.dataset.folder);}};
    card.querySelector('.instance-rename').onclick=event=>{
      event.stopPropagation();
      const instance=instances.find(item=>item.folder===card.dataset.folder);
      if(instance)showRenameInstanceDialog(instance);
    };
    card.querySelector('.instance-pin').onclick=event=>{
      event.stopPropagation();
      togglePinnedInstance(card.dataset.folder);
    };
  });
  renderSelectedInstance();
}

function instanceIconMarkup(instance){
  const identity=String(instance.folder||'').toLowerCase();
  const sword=identity.includes('pvp')?'<img class="instance-sword-icon" src="../assets/ironsword445x445.png" alt="" aria-hidden="true">':'';
  const heart=identity.includes('survival')?'<img class="instance-heart-icon" src="../assets/heartlogo266x266.png" alt="" aria-hidden="true">':'';
  return `${sword}${heart}`;
}

function instanceMetaMarkup(instance){
  const loader=String(instance.loader||'Vanilla');
  const fabric=loader.toLowerCase()==='fabric';
  return `<div class="meta instance-meta"><span>${escapeHtml(instance.version||'Unknown')}</span><span aria-hidden="true">·</span><span>${escapeHtml(loader)}</span>${fabric?'<img class="fabric-loader-icon" src="../assets/fabriclogo230x230.png" alt="" aria-hidden="true">':''}</div>`;
}

function selectInstance(folder){
  if(!instances.some(instance=>instance.folder===folder)) return;
  selectedInstanceFolder=folder;
  renderInstances();
}

function renderSelectedInstance(){
  const selected=instances.find(instance=>instance.folder===selectedInstanceFolder);
  const play=$('#selectedInstancePlay');
  if(!selected){
    play.hidden=true;
    play.classList.remove('play-appear');
    return;
  }
  const animate=play.hidden;
  play.hidden=false;
  play.disabled=false;
  play.textContent=selected.installed===false?'⬇ DOWNLOAD':'▶ PLAY';
  play.setAttribute('aria-label',`${selected.installed===false?'Download':'Play'} ${selected.name||selected.folder}`);
  if(animate){
    play.classList.remove('play-appear');
    void play.offsetWidth;
    play.classList.add('play-appear');
  }
}

async function launch(folder){
  const instance=instances.find(x=>x.folder===folder);
  if(!instance) return;
  try{
    await window.eclipse.instances.launch(instance);
    const now=Date.now();
    instance.lastPlayed=now;
    renderInstances(); renderQuick();
  }catch(e){ alert('Could not launch Minecraft:\n'+e.message); }
}

function renderQuick(){
  const pinned=pinnedInstanceFolders.map(folder=>instances.find(instance=>instance.folder===folder)).filter(Boolean);
  $('#quickLaunch').innerHTML=pinned.length?pinned.map(instance=>`<article class="quick-pin-item"><b class="quick-instance-name"><span>${escapeHtml(instance.name||instance.folder)}</span>${instanceIconMarkup(instance)}</b>${instanceMetaMarkup(instance)}<button class="play" data-folder="${escapeHtml(instance.folder)}">▶ PLAY</button></article>`).join(''):'<div class="quick-empty">No pinned instance</div>';
  $$('#quickLaunch .play').forEach(button=>button.onclick=()=>launch(button.dataset.folder));
}

async function togglePinnedInstance(folder){
  const next=pinnedInstanceFolders.includes(folder)
    ?pinnedInstanceFolders.filter(item=>item!==folder)
    :[...pinnedInstanceFolders,folder];
  try{
    await window.eclipse.settings.set({pinnedInstances:next});
    pinnedInstanceFolders=next;
    renderInstances();
    renderQuick();
  }catch(error){alert(`Could not update pinned instances:\n${error.message}`);}
}

async function loadNews(refresh=false){
  const container=$('#newsList');
  try{
    newsItems=await window.eclipse.news.list({refresh});
    if(!newsItems.length) throw new Error('No articles');
    container.innerHTML=newsItems.slice(0,6).map((n,index)=>`
      <article class="news-item" data-news="${index}">
        <div class="news-image-wrap">${n.image?`<img src="${escapeHtml(n.image)}" alt="" onerror="this.parentElement.classList.add('no-image');this.remove()">`:`<div class="news-image-fallback">⛏</div>`}</div>
        <div class="news-copy">
          <span class="tag">${escapeHtml(n.source==='Minecraft.net'?'Minecraft.net':'Minecraft News · cached official feed')}</span>
          <h3>${escapeHtml(n.title)}</h3>
          <p>${escapeHtml(n.description||'Official Minecraft news from Minecraft.net.')}</p>
          <small>${escapeHtml(formatDate(n.pubDate))}</small>
        </div>
        <button class="news-open" data-news="${index}">Read More →</button>
      </article>`).join('');
    $$('.news-open').forEach(b=>b.onclick=()=>openNews(Number(b.dataset.news)));
  }catch(e){
    container.innerHTML=`<article class="news-item news-error"><div><span class="tag">Minecraft</span><h3>Could not load Minecraft News</h3><p>Minecraft news is temporarily unavailable. Please try again later.</p></div><button id="retryNews">Retry</button></article>`;
    $('#retryNews').onclick=()=>loadNews(true);
  }
}

function formatDate(value){
  if(!value) return '';
  const d=new Date(value);
  return Number.isNaN(d.getTime())?value:d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}

async function openNews(index){
  const item=newsItems[index];
  if(!item?.link) return;
  try{ await window.eclipse.news.open(item.link); }
  catch(e){ alert('Could not open this Minecraft article:\n'+e.message); }
}

function escapeHtml(x){return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

$$('.nav').forEach(b=>b.onclick=()=>{
  const nextPage=$('#'+b.dataset.page);
  if(!nextPage||nextPage.classList.contains('active-page'))return;
  $$('.nav').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  $$('.page').forEach(page=>page.classList.remove('active-page','page-enter'));
  nextPage.classList.add('active-page');
  clearTimeout(pageAnimationTimer);
  if(pageAnimationDuration>0){
    void nextPage.offsetWidth;
    nextPage.classList.add('page-enter');
    pageAnimationTimer=setTimeout(()=>nextPage.classList.remove('page-enter'),pageAnimationDuration+50);
  }
});

$('#search').oninput=renderInstances;
$('#sort').onchange=renderInstances;
$('#selectedInstancePlay').onclick=()=>{if(selectedInstanceFolder) launch(selectedInstanceFolder);};
$('#changeBg').onclick=async()=>{
  const selected=await window.eclipse.background.choose();
  if(selected?.url) setBackgroundImage(selected.url);
};
$('#theme').onchange=async e=>{
  document.body.classList.toggle('light',e.target.value==='light');
  await window.eclipse.settings.set({theme:e.target.value});
};
$('#animationSpeed').onchange=async e=>{
  const speed=e.target.value;
  setAnimationSpeed(speed);
  await window.eclipse.settings.set({animationSpeed:speed});
};
$('#playAnimationSpeed').onchange=async e=>{
  const speed=e.target.value;
  setPlayAnimationSpeed(speed);
  await window.eclipse.settings.set({playAnimationSpeed:speed});
};
$('#newsEnabledToggle').onchange=async e=>{
  const enabled=e.target.checked;
  try{
    const settings=await window.eclipse.settings.set({newsEnabled:enabled});
    newsEnabled=settings.newsEnabled!==false;
    $('#newsEnabledToggle').checked=newsEnabled;
    $('#newsSection').hidden=!newsEnabled;
    if(newsEnabled){
      await loadNews();
      startNewsRefresh();
    }else{
      clearInterval(newsRefreshTimer);
      newsRefreshTimer=null;
    }
  }catch(error){
    e.target.checked=newsEnabled;
    alert(`Could not save the Minecraft News setting:\n${error.message}`);
  }
};
$('#accountCard').onclick=()=>$('#statusPop').classList.toggle('open');
$$('[data-status]').forEach(x=>x.onclick=async()=>{
  const status=x.dataset.status;
  const s=await window.eclipse.settings.get();
  s.profile.status=status;
  await window.eclipse.settings.set({profile:s.profile});
  updateStatusUI(status); $('#statusPop').classList.remove('open');
});
$$('[data-window]').forEach(b=>b.onclick=()=>{
  const a=b.dataset.window;
  window.eclipse.window[a==='min'?'minimize':a==='max'?'maximize':'close']();
});
$('#addProfileBtn').onclick=()=>{
  $('#profileCreator').hidden=false;
  setAccountType('offline');
  $('#offlineProfileName').focus();
};
$('#cancelAddProfile').onclick=()=>$('#profileCreator').hidden=true;
$$('[data-account-type]').forEach(button=>button.onclick=()=>setAccountType(button.dataset.accountType));
$('#createOfflineProfile').onclick=async()=>{
  const button=$('#createOfflineProfile');
  button.disabled=true;
  try{
    const updated=await window.eclipse.accounts.addOffline($('#offlineProfileName').value);
    renderProfiles(updated);
    applySettings(updated);
    $('#profileCreator').hidden=true;
    $('#offlineProfileName').value='';
  }catch(error){showAccountMessage(error.message,true);}
  finally{button.disabled=false;}
};
$('#loginMicrosoft').onclick=async()=>{
  const button=$('#loginMicrosoft');
  button.disabled=true;
  showAccountMessage('Opening Microsoft sign-in in your browser…');
  try{
    const updated=await window.eclipse.accounts.loginMicrosoft($('#microsoftClientId').value);
    renderProfiles(updated);
    applySettings(updated);
    $('#profileCreator').hidden=true;
    showAccountMessage('Microsoft account added.');
  }catch(error){showAccountMessage(error.message,true);}
  finally{button.disabled=false;}
};
$('#openEntraPortal').onclick=async event=>{
  event.preventDefault();
  await window.eclipse.accounts.openRegistration();
};
$('#removeProfileCancel').onclick=closeRemoveProfileDialog;
$('#removeProfileDialog').onclick=event=>{
  if(event.target.id==='removeProfileDialog')closeRemoveProfileDialog();
};
$('#removeProfileConfirm').onclick=async()=>{
  if(!removeProfileTarget)return;
  const button=$('#removeProfileConfirm');
  button.disabled=true;
  try{
    const updated=await window.eclipse.accounts.remove(removeProfileTarget.id);
    closeRemoveProfileDialog();
    renderProfiles(updated);
    applySettings(updated);
  }catch(error){
    $('#removeProfileError').textContent=error.message;
    $('#removeProfileError').hidden=false;
  }finally{button.disabled=false;}
};
$('#renameInstanceCancel').onclick=closeRenameInstanceDialog;
$('#renameInstanceDialog').onclick=event=>{
  if(event.target.id==='renameInstanceDialog')closeRenameInstanceDialog();
};
$('#renameInstanceSave').onclick=async()=>{
  if(!renameInstanceTarget)return;
  const button=$('#renameInstanceSave');
  const name=$('#renameInstanceInput').value.trim();
  button.disabled=true;
  try{
    const renamed=await window.eclipse.instances.rename(renameInstanceTarget.folder,name);
    const instance=instances.find(item=>item.folder===renamed.folder);
    if(instance)instance.name=renamed.name;
    closeRenameInstanceDialog();
    renderInstances();
    renderQuick();
  }catch(error){
    $('#renameInstanceError').textContent=error.message;
    $('#renameInstanceError').hidden=false;
    $('#renameInstanceInput').focus();
  }finally{button.disabled=false;}
};
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!$('#removeProfileDialog').hidden)closeRemoveProfileDialog();
  if(event.key==='Escape'&&!$('#renameInstanceDialog').hidden)closeRenameInstanceDialog();
  if(event.key==='Enter'&&!$('#renameInstanceDialog').hidden&&document.activeElement===$('#renameInstanceInput'))$('#renameInstanceSave').click();
});

setupCustomDropdowns();
init();
