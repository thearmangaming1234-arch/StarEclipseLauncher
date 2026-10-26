let instances=[];
let newsItems=[];
let profiles=[];
let selectedProfileId=null;
let selectedInstanceFolder=null;
let pinnedInstanceFolders=[];
let sidebarOrder=['home','mods','profile','settings'];
let newsEnabled=true;
let showPlaytime=true;
let playtimePosition='left';
let newsRefreshTimer=null;
let noteSaveTimer=null;
let noteSelectionRange=null;
let removeProfileTarget=null;
let renameInstanceTarget=null;
let deleteInstanceTarget=null;
let deleteInstanceStage=1;
let deletingInstance=false;
let resetPlaytimeTarget=null;
let resettingPlaytime=false;
let removeModTarget=null;
let modInstallBusy=false;
let modSearchRequestId=0;
let activeModsTab='installed';
let installedModsCache=[];
let installedModsCacheFolder=null;
let installedModsCacheFailed=false;
let installedModFilter='all';
let installedModQuery='';
let lastModrinthProjects=[];
let lastModrinthInstanceInstalled=false;
const modsListRequests=new Map();
let pageAnimationTimer=null;
let pageAnimationDuration=450;
let installProgressTimer=null;
let installingInstanceFolder=null;
let launchingInstanceFolder=null;
let playingInstanceFolder=null;
let selectedControlsShouldAnimate=false;
const skinUrlRequests=new Map();
const skinDataRequests=new Map();
let skinViewer=null;

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
  const validPins=pinnedInstanceFolders.filter(folder=>instances.some(instance=>instance.folder===folder&&instance.installed));
  if(validPins.length!==pinnedInstanceFolders.length) await window.eclipse.settings.set({pinnedInstances:validPins});
  pinnedInstanceFolders=validPins;
  renderInstances();
  renderQuick();
  setupModsPage();
  renderPlaytimeSettings();
  if(newsEnabled){
    await loadNews();
    startNewsRefresh();
  }
}

function setupModsPage(){
  const select=$('#modInstance');
  select.innerHTML=instances.length?instances.map(instance=>`<option value="${escapeHtml(instance.folder)}">${escapeHtml(instance.name||instance.folder)} · ${escapeHtml(instance.version||'Unknown')}</option>`).join(''):'<option value="">No instances found</option>';
  select.disabled=!instances.length;
  $('#modInstanceDropdownTrigger').disabled=!instances.length;
  $('#modInstanceDropdownMenu').innerHTML=[...select.options].map((option,index)=>`<button class="custom-select-option${index===0?' selected':''}" type="button" role="option" data-value="${escapeHtml(option.value)}" aria-selected="${index===0}" tabindex="-1">${escapeHtml(option.textContent)}</button>`).join('');
  syncCustomDropdown('modInstance');
  select.onchange=()=>{
    modSearchRequestId++;
    $('#modSearchBtn').disabled=false;
    $('#modResults').innerHTML='';
    lastModrinthProjects=[];
    $('#modSearchMessage').textContent='Search Modrinth for mods compatible with the selected instance.';
    $('#modInstallProgress').hidden=true;
    $('#modInstallProgress').classList.remove('error','complete');
    installedModsCache=[];
    installedModsCacheFolder=null;
    installedModsCacheFailed=false;
    refreshInstalledMods();
  };
  $('#installedModsTab').onclick=()=>setModsTab('installed');
  $('#modrinthTab').onclick=()=>setModsTab('modrinth');
  $('#refreshMods').onclick=()=>refreshInstalledMods();
  $('#openModsFolder').onclick=async()=>{
    try{await window.eclipse.mods.openFolder($('#modInstance').value);}
    catch(error){showInstanceNotice(error.message||'Could not open the selected mods folder.');}
  };
  $('#modSearchForm').onsubmit=event=>{event.preventDefault();searchModrinth();};
  $('#modList').onclick=handleInstalledModAction;
  $('#installedModSearch').oninput=()=>{installedModQuery=$('#installedModSearch').value.trim().toLocaleLowerCase();renderFilteredInstalledMods();};
  $('#installedModFilters').onclick=event=>{
    const button=event.target.closest('[data-mod-filter]');
    if(!button)return;
    installedModFilter=button.dataset.modFilter;
    $$('#installedModFilters [data-mod-filter]').forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});
    renderFilteredInstalledMods();
  };
  $('#modResults').onclick=handleModrinthAction;
  $('#removeModCancel').onclick=closeRemoveModDialog;
  $('#removeModDialog').onclick=event=>{if(event.target.id==='removeModDialog')closeRemoveModDialog();};
  $('#removeModConfirm').onclick=confirmRemoveMod;
  updateModInstanceStatus();
}

function setModsTab(tab){
  activeModsTab=tab==='modrinth'?'modrinth':'installed';
  const installed=activeModsTab==='installed';
  $('#installedModsTab').classList.toggle('active',installed);
  $('#installedModsTab').setAttribute('aria-selected',String(installed));
  $('#modrinthTab').classList.toggle('active',!installed);
  $('#modrinthTab').setAttribute('aria-selected',String(!installed));
  $('#installedModsView').hidden=!installed;
  $('#modrinthView').hidden=installed;
  if(installed)refreshInstalledMods();
  else {refreshInstalledMods();updateModInstanceStatus();}
}

function updateModInstanceStatus(installedOverride){
  const instance=instances.find(item=>item.folder===$('#modInstance').value);
  const installed=typeof installedOverride==='boolean'?installedOverride:Boolean(instance?.installed);
  const status=$('#modInstanceStatus');
  status.classList.toggle('not-installed',!installed);
  status.innerHTML=instance?`<span class="mod-status-dot"></span><b>${installed?'Installed':'Not installed'}</b><span>${escapeHtml(instance.name||instance.folder)} · Minecraft ${escapeHtml(instance.version||'Unknown')} · Fabric</span>`:'No Minecraft instances were found.';
}

async function refreshInstalledMods(){
  const folder=$('#modInstance').value;
  const instance=instances.find(item=>item.folder===folder);
  const list=$('#modList');
  if(!instance){installedModsCache=[];installedModsCacheFolder=null;if(activeModsTab==='installed')list.innerHTML='<div class="mod-empty-card">No instances were found. Add an instance before managing mods.</div>';$('#installedModCount').textContent='0';updateModInstanceStatus(false);return;}
  installedModsCacheFailed=false;
  if(activeModsTab==='installed'){$('#installedModCount').textContent='…';list.innerHTML='<div class="mod-empty-card mod-loading"><span class="mod-spinner"></span>Loading this instance’s mods…</div>';}
  updateModInstanceStatus();
  try{
    const result=await getInstanceMods(folder);
    if(folder!==$('#modInstance').value)return;
    installedModsCache=result.installed?result.mods:[];
    installedModsCacheFolder=folder;
    installedModsCacheFailed=false;
    updateModInstanceStatus(result.installed);
    if(!result.installed){
      $('#installedModCount').textContent='0';
      if(activeModsTab==='installed')list.innerHTML=`<div class="mod-empty-card"><span class="mod-empty-icon">↓</span><h3>${escapeHtml(instance.name||instance.folder)} isn’t installed</h3><p>Install the instance from Home first. Once it’s ready, its mods will appear here.</p></div>`;
      else renderModrinthResults();
      return;
    }
    $('#installedModCount').textContent=String(result.mods.length);
    if(activeModsTab==='installed')renderFilteredInstalledMods();
    else renderModrinthResults();
  }catch(error){
    if(folder!==$('#modInstance').value)return;
    installedModsCache=[];
    installedModsCacheFolder=null;
    installedModsCacheFailed=true;
    if(activeModsTab==='installed'){
      list.innerHTML=`<div class="mod-empty-card mod-error"><h3>Couldn’t read this instance’s mods</h3><p>${escapeHtml(error.message)}</p><button class="mod-inline-link" type="button" data-retry-mods>Try again</button></div>`;
      list.querySelector('[data-retry-mods]').onclick=refreshInstalledMods;
    }else renderModrinthResults();
  }
}

function getInstanceMods(folder){
  if(!modsListRequests.has(folder)){
    let timeout;
    const request=Promise.race([
      window.eclipse.mods.list(folder),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Reading this instance’s mods took too long. Try Refresh again.')),15000);})
    ]).finally(()=>{clearTimeout(timeout);if(modsListRequests.get(folder)===request)modsListRequests.delete(folder);});
    modsListRequests.set(folder,request);
  }
  return modsListRequests.get(folder);
}

function renderFilteredInstalledMods(){
  const list=$('#modList');
  if(!list||activeModsTab!=='installed')return;
  const filtered=installedModsCache.filter(mod=>{
    const stateMatches=installedModFilter==='all'||(installedModFilter==='enabled'?mod.enabled:!mod.enabled);
    const haystack=`${mod.name||''} ${mod.id||''} ${mod.baseName||''} ${mod.description||''}`.toLocaleLowerCase();
    return stateMatches&&haystack.includes(installedModQuery);
  });
  if(!installedModsCache.length){
    const instance=instances.find(item=>item.folder===$('#modInstance').value);
    if(instance?.installed===false)list.innerHTML=`<div class="mod-empty-card"><span class="mod-empty-icon">↓</span><h3>${escapeHtml(instance.name||instance.folder)} isn’t installed</h3><p>Install the instance from Home first. Once it’s ready, its mods will appear here.</p></div>`;
    else {list.innerHTML='<div class="mod-empty-card"><span class="mod-empty-icon">✣</span><h3>No mods found</h3><p>This instance’s mods folder is empty. Find compatible mods in the Modrinth tab.</p><button class="mod-inline-link" type="button" data-go-modrinth>Browse Modrinth →</button></div>';list.querySelector('[data-go-modrinth]').onclick=()=>setModsTab('modrinth');}
    return;
  }
  if(!filtered.length){
    const message=installedModQuery?'No installed mods match this search.':`No ${installedModFilter} mods in this instance.`;
    list.innerHTML=`<div class="mod-empty-card"><span class="mod-empty-icon">⌕</span><h3>${escapeHtml(message)}</h3><p>Change the search or choose another filter.</p></div>`;
    return;
  }
  list.innerHTML=filtered.map(renderInstalledModCard).join('');
}

function renderInstalledModCard(mod){
  const initial=escapeHtml((mod.name||'?').slice(0,1).toUpperCase());
  const icon=mod.icon?`<img src="${escapeHtml(mod.icon)}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="mod-icon-fallback" hidden>${initial}</span>`:`<span>${initial}</span>`;
  const status=mod.enabled?'<span class="mod-state enabled">Enabled</span>':'<span class="mod-state disabled">Disabled</span>';
  const sourceTag=mod.modrinthProjectId?'<span class="mod-source-tag">Installed from Modrinth</span>':mod.builtIn?'':'<span class="mod-source-tag manual">Added manually</span>';
  return `<article class="mod-card installed-mod-card"><div class="mod-card-icon${mod.icon?'':' no-mod-icon'}">${icon}</div><div class="mod-card-copy"><div class="mod-card-title-row"><h3>${escapeHtml(mod.name)}</h3>${mod.builtIn?'<span class="mod-built-in">Built-in</span>':''}${sourceTag}${status}</div><p>${escapeHtml(mod.description)}</p><div class="mod-card-meta">${mod.version?`<span>v${escapeHtml(mod.version)}</span>`:''}<code>${escapeHtml(mod.id||mod.baseName)}</code></div></div><div class="mod-card-actions"><button class="mod-action-button ${mod.enabled?'':'enable'}" type="button" data-mod-action="toggle" data-file-name="${escapeHtml(mod.fileName)}" data-enabled="${mod.enabled}" ${modInstallBusy?'disabled':''}>${mod.enabled?'Disable':'Enable'}</button><button class="mod-action-button remove" type="button" data-mod-action="remove" data-file-name="${escapeHtml(mod.fileName)}" data-mod-name="${escapeHtml(mod.name)}" ${modInstallBusy?'disabled':''}>Remove</button></div></article>`;
}

async function handleInstalledModAction(event){
  const button=event.target.closest('[data-mod-action]');
  if(!button||button.disabled)return;
  const folder=$('#modInstance').value;
  if(button.dataset.modAction==='remove'){
    removeModTarget={folder,fileName:button.dataset.fileName,name:button.dataset.modName};
    $('#removeModName').textContent=removeModTarget.name;
    $('#removeModError').hidden=true;
    $('#removeModDialog').hidden=false;
    $('#removeModCancel').focus();
    return;
  }
  button.disabled=true;
  try{
    const result=await window.eclipse.mods.setEnabled(folder,button.dataset.fileName,button.dataset.enabled!=='true');
    installedModsCache=result.mods;
    $('#installedModCount').textContent=String(result.mods.length);
    renderFilteredInstalledMods();
  }catch(error){showInstanceNotice(`Could not change mod state: ${error.message}`);button.disabled=false;}
}

function closeRemoveModDialog(){
  $('#removeModDialog').hidden=true;
  removeModTarget=null;
}

async function confirmRemoveMod(){
  if(!removeModTarget)return;
  const target=removeModTarget;
  const button=$('#removeModConfirm');
  button.disabled=true;
  try{
    const result=await window.eclipse.mods.remove(target.folder,target.fileName);
    closeRemoveModDialog();
    installedModsCache=result.mods;
    $('#installedModCount').textContent=String(result.mods.length);
    renderFilteredInstalledMods();
  }catch(error){$('#removeModError').textContent=error.message;$('#removeModError').hidden=false;}
  finally{button.disabled=false;}
}

async function searchModrinth(){
  const query=$('#modSearch').value.trim();
  const folder=$('#modInstance').value;
  const message=$('#modSearchMessage');
  const results=$('#modResults');
  if(!query){lastModrinthProjects=[];message.textContent='Enter a mod name to search Modrinth.';results.innerHTML='';return;}
  const requestId=++modSearchRequestId;
  lastModrinthProjects=[];
  $('#modSearchBtn').disabled=true;
  message.textContent='Searching compatible Fabric mods…';
  results.innerHTML='<div class="mod-empty-card mod-loading"><span class="mod-spinner"></span>Finding mods for this Minecraft version…</div>';
  try{
    const response=await window.eclipse.mods.search(folder,query);
    if(requestId!==modSearchRequestId)return;
    lastModrinthProjects=response.projects;
    lastModrinthInstanceInstalled=response.installed;
    const instance=instances.find(item=>item.folder===folder);
    const minecraftVersion=instance?.version||'this version';
    message.textContent=`${response.projects.length} compatible result${response.projects.length===1?'':'s'} for Minecraft ${minecraftVersion} · Fabric${response.installed?'':' · install the instance before adding mods'}.`;
    renderModrinthResults();
  }catch(error){
    if(requestId!==modSearchRequestId)return;
    message.textContent=`Modrinth search failed: ${error.message}`;
    results.innerHTML='<div class="mod-empty-card mod-error"><h3>Couldn’t reach Modrinth</h3><p>Check your connection and try the search again.</p><button class="mod-inline-link" type="button" data-search-retry>Retry search</button></div>';
    results.querySelector('[data-search-retry]').onclick=searchModrinth;
  }finally{if(requestId===modSearchRequestId)$('#modSearchBtn').disabled=false;}
}

function renderModrinthResults(){
  const results=$('#modResults');
  if(!results||!lastModrinthProjects.length){
    if(results&&$('#modSearchMessage').textContent.includes('compatible result'))results.innerHTML='<div class="mod-empty-card"><h3>No compatible mods found</h3><p>Try a different search, or check the spelling.</p></div>';
    return;
  }
  results.innerHTML=lastModrinthProjects.map(project=>renderModrinthCard(project,lastModrinthInstanceInstalled)).join('');
}

function renderModrinthCard(project,instanceInstalled){
  const initial=escapeHtml((project.title||'?').slice(0,1).toUpperCase());
  const icon=project.icon?`<img src="${escapeHtml(project.icon)}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="mod-icon-fallback" hidden>${initial}</span>`:`<span>${initial}</span>`;
  const downloads=Intl.NumberFormat().format(project.downloads);
  const alreadyInstalled=installedModsCache.some(mod=>{
    const ids=[mod.id,mod.modrinthSlug,mod.baseName?.replace(/\.jar(?:\.disabled)?$/i,'')].map(value=>String(value||'').toLowerCase());
    return mod.modrinthProjectId===project.id||ids.includes(String(project.slug||'').toLowerCase());
  });
  const disabled=alreadyInstalled||!instanceInstalled||modInstallBusy;
  const inventoryPending=installedModsCacheFolder!==$('#modInstance').value&&!installedModsCacheFailed;
  const inventoryFailed=installedModsCacheFailed&&installedModsCacheFolder!==$('#modInstance').value;
  const label=alreadyInstalled?'Installed':modInstallBusy?'Installing…':inventoryPending?'Checking installed…':inventoryFailed?'Could not verify':instanceInstalled?'Install':'Install instance first';
  return `<article class="mod-card modrinth-mod-card"><div class="mod-card-icon modrinth-icon${project.icon?'':' no-mod-icon'}">${icon}</div><div class="mod-card-copy"><div class="mod-card-title-row"><h3>${escapeHtml(project.title)}</h3><span class="mod-platform-tag">Fabric</span></div><p>${escapeHtml(project.description)}</p><div class="mod-card-meta"><span>↓ ${downloads} downloads</span>${project.slug?`<code>${escapeHtml(project.slug)}</code>`:''}</div></div><button class="mod-install-button${alreadyInstalled?' already-installed':''}" type="button" data-project-id="${escapeHtml(project.id)}" ${disabled||inventoryPending||inventoryFailed?'disabled':''}>${label}</button></article>`;
}

async function handleModrinthAction(event){
  const button=event.target.closest('[data-project-id]');
  if(!button||button.disabled||modInstallBusy)return;
  const folder=$('#modInstance').value;
  modInstallBusy=true;
  $$('#modResults [data-project-id]').forEach(item=>{item.disabled=true;item.textContent='Installing…';});
  $('#modInstallProgress').hidden=false;
  $('#modInstallProgress').classList.remove('error','complete');
  $('#modInstallProgressLabel').textContent='Checking mod version and required dependencies…';
  $('#modInstallProgressPercent').textContent='';
  $('#modInstallProgressFill').style.width='4%';
  try{
    const result=await window.eclipse.mods.install(folder,button.dataset.projectId);
    if(folder===$('#modInstance').value){
      const installedCount=result.installedCount||0;
      $('#modInstallProgressLabel').textContent=installedCount?`Installed ${installedCount} mod${installedCount===1?'':'s'} including required dependencies`:'All required mods were already installed';
      $('#modInstallProgressPercent').textContent='Done';
      $('#modInstallProgressFill').style.width='100%';
      $('#modInstallProgress').classList.add('complete');
      await refreshInstalledMods();
      showInstanceNotice(installedCount?'Mod and required dependencies installed successfully.':'This mod and its required dependencies are already installed.');
    }
  }catch(error){
    if(folder===$('#modInstance').value){
      $('#modInstallProgress').classList.add('error');
      $('#modInstallProgressLabel').textContent=error.message||'Mod installation failed.';
      $('#modInstallProgressPercent').textContent='';
      showInstanceNotice(`Could not install mod: ${error.message}`);
    }
  }finally{
    modInstallBusy=false;
    if(folder===$('#modInstance').value&&activeModsTab==='modrinth')await searchModrinthAfterInstall(folder);
    if(activeModsTab==='installed'&&folder===$('#modInstance').value)refreshInstalledMods();
  }
}

async function searchModrinthAfterInstall(folder){
  if(activeModsTab!=='modrinth'||folder!==$('#modInstance').value||!$('#modSearch').value.trim())return;
  await searchModrinth();
}

function updateModInstallProgress(progress){
  if(progress.folder!==$('#modInstance').value)return;
  const panel=$('#modInstallProgress');
  panel.hidden=false;
  panel.classList.toggle('error',Boolean(progress.error));
  panel.classList.toggle('complete',Boolean(progress.complete));
  $('#modInstallProgressLabel').textContent=progress.status||'Installing mods…';
  $('#modInstallProgressPercent').textContent=Number.isFinite(progress.percent)?`${progress.percent}%`:'';
  if(Number.isFinite(progress.percent))$('#modInstallProgressFill').style.width=`${Math.max(0,Math.min(100,progress.percent))}%`;
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
  showPlaytime=s.showPlaytime!==false;
  $('#showPlaytimeToggle').checked=showPlaytime;
  playtimePosition=s.playtimePosition==='right'?'right':'left';
  $('#playtimePosition').value=playtimePosition;
  syncCustomDropdown('playtimePosition');
  $('.selected-instance-bar').classList.toggle('playtime-right',playtimePosition==='right');
  newsEnabled=s.newsEnabled!==false;
  $('#newsEnabledToggle').checked=newsEnabled;
  $('#newsSection').hidden=!newsEnabled;
  $('#showFriendsBoxToggle').checked=s.showFriendsBox!==false;
  $('#friendsBox').hidden=s.showFriendsBox===false;
  $('#showQuickLaunchToggle').checked=s.showQuickLaunch!==false;
  $('#quickLaunchPanel').hidden=s.showQuickLaunch===false;
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
      <div class="skin-viewer-content"><div class="skin-assets-column">${skinHeadMarkup(selected.name,'skin-viewer-head')}<div class="skin-texture-wrap"><span class="skin-texture-label">Full skin texture</span><div class="skin-texture-frame"><img id="skinTexturePreview" alt="${escapeHtml(selected.name)} Minecraft skin texture"><span id="skinMessage">Looking for this skin…</span></div></div></div><div class="skin-3d-wrap"><span class="skin-texture-label">3D preview · drag to rotate</span><canvas id="skin3dCanvas" aria-label="3D preview of ${escapeHtml(selected.name)}'s Minecraft skin"></canvas></div></div>
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
    const canvas=$('#skin3dCanvas');
    hydrateSkinHead(head,selected.id,selected.name);
    hydrateSkinHead(viewerHead,selected.id,selected.name,texture,message);
    initializeSkinViewer(canvas,selected.id,message);
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

function showDeleteInstanceDialog(instance){
  deleteInstanceTarget=instance;
  deleteInstanceStage=1;
  $('#deleteInstanceTitle').textContent='Delete instance files?';
  $('#deleteInstanceDescription').innerHTML=`This will remove the worlds, resource packs, mods, settings, and other downloaded files for <b>${escapeHtml(instance.name||instance.folder)}</b>. You can install this instance again later. Eclipse will keep its instance profile file.`;
  $('#deleteInstanceConfirm').textContent='Yes, I want to delete';
  $('#deleteInstanceError').hidden=true;
  $('#deleteInstanceError').textContent='';
  $('#deleteInstanceDialog').hidden=false;
  $('#deleteInstanceCancel').focus();
}

function closeDeleteInstanceDialog(){
  if(deletingInstance)return;
  $('#deleteInstanceDialog').hidden=true;
  $('#deleteInstanceFinalDialog').hidden=true;
  deleteInstanceTarget=null;
  deleteInstanceStage=1;
}

async function confirmDeleteInstance(){
  if(!deleteInstanceTarget)return;
  if(deleteInstanceStage===1){
    deleteInstanceStage=2;
    $('#deleteInstanceDialog').hidden=true;
    $('#deleteInstanceFinalDescription').textContent=`This will permanently remove every file in ${deleteInstanceTarget.name||deleteInstanceTarget.folder} except eclipse-instance.json. Your worlds and downloaded content cannot be recovered from this device. You can install the instance again later.`;
    $('#deleteInstanceFinalError').hidden=true;
    $('#deleteInstanceFinalError').textContent='';
    $('#deleteInstanceFinalDialog').hidden=false;
    $('#deleteInstanceFinalCancel').focus();
    return;
  }
}

async function performDeleteInstance(){
  if(!deleteInstanceTarget||deleteInstanceStage!==2)return;
  const target=deleteInstanceTarget;
  const cancel=$('#deleteInstanceFinalCancel');
  const confirm=$('#deleteInstanceFinalConfirm');
  cancel.disabled=true;
  confirm.disabled=true;
  deletingInstance=true;
  confirm.textContent='Deleting…';
  try{
    await window.eclipse.instances.deleteFiles(target.folder);
    pinnedInstanceFolders=pinnedInstanceFolders.filter(folder=>folder!==target.folder);
    instances=await window.eclipse.instances.list();
    deletingInstance=false;
    closeDeleteInstanceDialog();
    renderInstances();
    renderQuick();
    showInstanceNotice(`${target.name||target.folder} files deleted. You can install this instance again anytime.`);
  }catch(error){
    $('#deleteInstanceFinalError').textContent=error.message;
    $('#deleteInstanceFinalError').hidden=false;
  }finally{
    deletingInstance=false;
    cancel.disabled=false;
    confirm.disabled=false;
    if(!$('#deleteInstanceFinalDialog').hidden)confirm.textContent='Yes, delete everything';
  }
}

function skinHeadMarkup(name,extraClass=''){
  const initial=escapeHtml((name||'?').slice(0,1).toUpperCase());
  return `<span class="skin-head ${extraClass}"><span class="skin-initial">${initial}</span><img class="skin-head-base" alt=""><img class="skin-head-hat" alt=""></span>`;
}

async function initializeSkinViewer(canvas,profileId,statusMessage){
  if(skinViewer){
    skinViewer.resizeObserver?.disconnect();
    skinViewer.viewer?.dispose();
    skinViewer=null;
  }
  if(!canvas||!window.skinview3d?.SkinViewer)return;
  try{
    let skinData=skinDataRequests.get(profileId);
    if(!skinData){
      skinData=window.eclipse.accounts.skinData(profileId).finally(()=>skinDataRequests.delete(profileId));
      skinDataRequests.set(profileId,skinData);
    }
    const dataUrl=await skinData;
    if(!canvas.isConnected)return;
    const viewer=new window.skinview3d.SkinViewer({canvas,width:220,height:220,skin:dataUrl,zoom:.72,background:0x0b1322,alpha:true,renderPaused:!canvas.closest('#profile')?.classList.contains('active-page')});
    viewer.playerWrapper.position.x=-7.5;
    viewer.autoRotate=true;
    const resize=()=>{
      if(!canvas.isConnected)return;
      const bounds=canvas.getBoundingClientRect();
      if(bounds.width<1||bounds.height<1)return;
      viewer.width=Math.round(bounds.width);
      viewer.height=Math.round(bounds.height);
    };
    const resizeObserver=new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();
    skinViewer={viewer,resizeObserver,profileId,resize};
  }catch(error){
    if(canvas.isConnected&&statusMessage){
      statusMessage.hidden=false;
      statusMessage.textContent=`3D preview unavailable: ${error.message}`;
    }
  }
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
    if(root.dataset.wired==='true')return;
    root.dataset.wired='true';
    const select=root.querySelector('select');
    const trigger=root.querySelector('.custom-select-trigger');
    syncCustomDropdown(select.id);
    trigger.onclick=()=>root.classList.contains('open')?close(root):open(root);
    trigger.onkeydown=event=>{
      if(['ArrowDown','ArrowUp','Enter',' '].includes(event.key)){
        event.preventDefault();
        open(root,true);
      }
    };
    const menu=root.querySelector('.custom-select-menu');
    menu.onclick=event=>{
      const option=event.target.closest('.custom-select-option');
      if(!option)return;
      select.value=option.dataset.value;
      syncCustomDropdown(select.id);
      close(root);
      select.dispatchEvent(new Event('change',{bubbles:true}));
      trigger.focus();
    };
    menu.onkeydown=event=>{
      const options=[...root.querySelectorAll('.custom-select-option')];
      if(!options.length)return;
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
        <div class="instance-heading"><h3><span class="instance-name-label">${escapeHtml(i.name||i.folder)}</span>${instanceIconMarkup(i)}</h3><span class="instance-actions"><span class="instance-action-buttons"><button class="instance-pin${pinnedInstanceFolders.includes(i.folder)?' pinned':''}" type="button" aria-label="${pinnedInstanceFolders.includes(i.folder)?'Unpin':'Pin'} ${escapeHtml(i.name||i.folder)} in Quick Launch" title="${pinnedInstanceFolders.includes(i.folder)?'Unpin instance':'Pin to Quick Launch'}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5h6l-.7 3 2.2 2.2v1H8.5v4.8l-.5.8-.5-.8V8.7H3.5v-1l2.2-2.2L5 2.5Z"/></svg></button><button class="instance-rename" type="button" aria-label="Rename ${escapeHtml(i.name||i.folder)}" title="Rename instance"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m2.5 11.5-.7 3 3-.7 8.1-8.1a1.63 1.63 0 0 0-2.3-2.3l-8.1 8.1Z"/><path d="m9.8 4.3 2.3 2.3"/></svg></button><button class="instance-delete" type="button" aria-label="Delete files for ${escapeHtml(i.name||i.folder)}" title="Delete instance files"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2.5 0-.6 9.5H4.1L3.5 4m3 2v5m3-5v5"/></svg></button></span><span class="instance-install-state ${installingInstanceFolder===i.folder?'install-state-installing':i.installed===false?'install-state-uninstalled':'install-state-installed'}">${installingInstanceFolder===i.folder?'Installing':i.installed===false?'Not installed':'Installed'}</span></span></div>
        ${instanceMetaMarkup(i)}
      </div>
    </article>`).join('') || `<div class="panel">No instances found.</div>`;
  $$('.instance[data-folder]').forEach(card=>{
    card.onclick=event=>{if(!event.target.closest('.instance-actions button'))selectInstance(card.dataset.folder);};
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
    card.querySelector('.instance-delete').onclick=event=>{
      event.stopPropagation();
      const instance=instances.find(item=>item.folder===card.dataset.folder);
      if(instance)showDeleteInstanceDialog(instance);
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
  if(folder!==selectedInstanceFolder)selectedControlsShouldAnimate=true;
  selectedInstanceFolder=folder;
  renderInstances();
}

function renderSelectedInstance(){
  const selected=instances.find(instance=>instance.folder===selectedInstanceFolder);
  const play=$('#selectedInstancePlay');
  const playtime=$('#selectedInstancePlaytime');
  if(!selected){
    play.hidden=true;
    play.classList.remove('play-appear');
    playtime.hidden=true;
    playtime.classList.remove('play-appear');
    selectedControlsShouldAnimate=false;
    return;
  }
  const animate=selectedControlsShouldAnimate||play.hidden;
  const animatePlaytime=showPlaytime&&(selectedControlsShouldAnimate||playtime.hidden);
  playtime.hidden=!showPlaytime;
  $('#selectedInstancePlaytimeValue').textContent=formatInstancePlaytime(selected.playtimeMs);
  play.hidden=false;
  const installing=installingInstanceFolder===selected.folder;
  const starting=launchingInstanceFolder===selected.folder;
  const playing=playingInstanceFolder===selected.folder;
  const anotherGameActive=Boolean((launchingInstanceFolder||playingInstanceFolder)&&!starting&&!playing);
  const busy=installing||starting||playing||anotherGameActive;
  play.disabled=busy;
  play.classList.toggle('installing',installing||starting);
  play.classList.toggle('is-busy',busy);
  if(installing){
    play.innerHTML='<span class="button-spinner" aria-hidden="true"></span> INSTALLING…';
  }else if(starting){
    play.innerHTML='<span class="button-spinner" aria-hidden="true"></span> LOADING…';
  }else if(playing){
    play.textContent='PLAYING';
  }else if(anotherGameActive&&selected.installed){
    play.textContent='GAME RUNNING';
  }else if(selected.installed===false){
    play.innerHTML='<svg class="install-button-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v9m0 0 3.5-3.5M10 11.5 6.5 8M3 13.5v3h14v-3"/></svg> INSTALL';
  }else{
    play.innerHTML='<svg class="install-button-icon play-button-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 3.5 10 6.5-10 6.5z"/></svg> PLAY';
  }
  play.setAttribute('aria-label',`${installing?'Installing':starting?'Loading':playing?'Playing':anotherGameActive&&selected.installed?'Another Minecraft instance is running':selected.installed===false?'Install':'Play'} ${selected.name||selected.folder}`);
  if(animate){
    play.classList.remove('play-appear');
    void play.offsetWidth;
    play.classList.add('play-appear');
  }
  if(animatePlaytime){
    playtime.classList.remove('play-appear');
    void playtime.offsetWidth;
    playtime.classList.add('play-appear');
  }
  selectedControlsShouldAnimate=false;
}

function formatInstancePlaytime(milliseconds){
  const minutes=Math.floor(Math.max(0,Number(milliseconds)||0)/60000);
  const hours=Math.floor(minutes/60);
  return `${String(hours).padStart(2,'0')}h${String(minutes%60).padStart(2,'0')}`;
}

function renderPlaytimeSettings(){
  const total=instances.reduce((sum,instance)=>sum+Math.max(0,Number(instance.playtimeMs)||0),0);
  $('#playtimeTotal').textContent=formatInstancePlaytime(total);
  const sorted=[...instances].sort((a,b)=>(Number(b.playtimeMs)||0)-(Number(a.playtimeMs)||0));
  $('#playtimeStats').innerHTML=sorted.length?sorted.map(instance=>{
    const time=Math.max(0,Number(instance.playtimeMs)||0);
    const percent=total?time/total*100:0;
    const busy=installingInstanceFolder===instance.folder||launchingInstanceFolder===instance.folder||playingInstanceFolder===instance.folder;
    return `<div class="playtime-stat-row">
      <div class="playtime-stat-heading"><div><strong>${escapeHtml(instance.name||instance.folder)}</strong><span>${formatInstancePlaytime(time)} <i>·</i> ${percent.toFixed(1)}%</span></div><button type="button" class="playtime-reset" data-reset-playtime="${escapeHtml(instance.folder)}" ${busy?'disabled':''}>Reset</button></div>
      <div class="playtime-meter" role="progressbar" aria-label="${escapeHtml(instance.name||instance.folder)} share of total playtime" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(1)}"><span style="width:${percent.toFixed(2)}%"></span></div>
    </div>`;
  }).join(''):'<div class="playtime-empty">No instances found.</div>';
  $$('[data-reset-playtime]').forEach(button=>button.onclick=()=>showResetPlaytimeDialog(button.dataset.resetPlaytime));
}

function showResetPlaytimeDialog(folder){
  const instance=instances.find(item=>item.folder===folder);
  if(!instance)return;
  resetPlaytimeTarget=instance;
  $('#resetPlaytimeTitle').textContent=`Reset ${instance.name||instance.folder} playtime?`;
  $('#resetPlaytimeDescription').textContent=`This will reset this instance's tracked playtime of ${formatInstancePlaytime(instance.playtimeMs)} to 00h00. This cannot be undone.`;
  $('#resetPlaytimeError').hidden=true;
  $('#resetPlaytimeError').textContent='';
  $('#resetPlaytimeDialog').hidden=false;
  $('#resetPlaytimeCancel').focus();
}

function closeResetPlaytimeDialog(){
  if(resettingPlaytime)return;
  $('#resetPlaytimeDialog').hidden=true;
  resetPlaytimeTarget=null;
}

async function confirmResetPlaytime(){
  if(!resetPlaytimeTarget)return;
  const target=resetPlaytimeTarget;
  const cancel=$('#resetPlaytimeCancel');
  const confirm=$('#resetPlaytimeConfirm');
  cancel.disabled=true;
  confirm.disabled=true;
  resettingPlaytime=true;
  try{
    await window.eclipse.instances.resetPlaytime(target.folder);
    target.playtimeMs=0;
    resettingPlaytime=false;
    closeResetPlaytimeDialog();
    renderPlaytimeSettings();
    renderSelectedInstance();
    showInstanceNotice(`${target.name||target.folder} playtime was reset.`);
  }catch(error){
    $('#resetPlaytimeError').textContent=error.message;
    $('#resetPlaytimeError').hidden=false;
  }finally{
    resettingPlaytime=false;
    cancel.disabled=false;
    confirm.disabled=false;
  }
}

function showInstanceNotice(message){
  const notice=$('#appNotice');
  notice.textContent=message;
  notice.hidden=false;
  clearTimeout(notice._hideTimer);
  notice._hideTimer=setTimeout(()=>{notice.hidden=true;},3600);
}

function updateInstanceInstallProgress(progress){
  const panel=$('#instanceInstallProgress');
  const percent=progress.percent;
  const isLaunch=progress.kind==='launch';
  clearTimeout(installProgressTimer);
  if(progress.phase==='complete'){
    panel.classList.remove('error','indeterminate');
    $('#instanceInstallProgressTitle').textContent=progress.status==='Minecraft started'?'Minecraft started':'Instance ready';
    $('#instanceInstallProgressStatus').textContent=progress.status;
    $('#instanceInstallProgressFill').style.width='100%';
    installProgressTimer=setTimeout(()=>{panel.hidden=true;},1800);
    return;
  }
  panel.hidden=false;
  panel.classList.toggle('launch-progress',isLaunch);
  panel.classList.toggle('error',progress.phase==='error');
  panel.classList.toggle('indeterminate',!isLaunch&&percent==null);
  $('#instanceInstallProgressTitle').textContent=isLaunch?'Preparing Minecraft':progress.phase==='minecraft-startup'?'Loading Minecraft':progress.phase==='dependencies'||progress.phase==='launching'?'Preparing Minecraft':`Installing ${instances.find(item=>item.folder===progress.folder)?.name||'instance'}`;
  $('#instanceInstallProgressStatus').hidden=isLaunch;
  $('#instanceInstallProgressStatus').textContent=isLaunch?'':progress.status||'Working…';
  $('#instanceInstallProgressFill').style.width=percent==null?'35%':`${Math.max(0,Math.min(100,percent))}%`;
  if(progress.phase==='error'){
    installProgressTimer=setTimeout(()=>{panel.hidden=true;},7000);
  }
}

async function installInstance(folder){
  const instance=instances.find(item=>item.folder===folder);
  if(!instance||instance.installed||installingInstanceFolder)return;
  installingInstanceFolder=folder;
  renderInstances();
  $('#instanceInstallProgress').hidden=false;
  $('#instanceInstallProgressTitle').textContent=`Installing ${instance.name||instance.folder}`;
  $('#instanceInstallProgressStatus').hidden=false;
  $('#instanceInstallProgress').classList.remove('launch-progress');
  $('#instanceInstallProgressStatus').textContent='Starting download…';
  $('#instanceInstallProgressFill').style.width='0%';
  $('#instanceInstallProgress').classList.add('indeterminate');
  try{
    await window.eclipse.instances.install(folder);
    instances=await window.eclipse.instances.list();
    renderInstances();
    renderQuick();
    showInstanceNotice(`${instance.name||instance.folder} is installed and ready to play.`);
  }catch(error){
    showInstanceNotice(`Could not install ${instance.name||instance.folder}: ${error.message}`);
  }finally{
    installingInstanceFolder=null;
    renderInstances();
    renderQuick();
  }
}

async function launch(folder){
  const instance=instances.find(x=>x.folder===folder);
  if(!instance) return;
  if(instance.installed===false){
    showInstanceNotice('Install this instance before launching it.');
    return;
  }
  if(launchingInstanceFolder||playingInstanceFolder){
    showInstanceNotice('Minecraft is already starting or running. Close it before launching another instance.');
    return;
  }
  launchingInstanceFolder=folder;
  $('#instanceInstallProgress').hidden=false;
  $('#instanceInstallProgress').classList.remove('error');
  $('#instanceInstallProgress').classList.remove('indeterminate');
  $('#instanceInstallProgress').classList.add('launch-progress');
  $('#instanceInstallProgressTitle').textContent='Preparing Minecraft';
  $('#instanceInstallProgressStatus').hidden=true;
  $('#instanceInstallProgressFill').style.width='5%';
  renderInstances();
  renderQuick();
  try{
    await window.eclipse.instances.launch(instance);
    renderInstances(); renderQuick();
  }catch(e){
    launchingInstanceFolder=null;
    $('#instanceInstallProgress').hidden=false;
    $('#instanceInstallProgress').classList.add('error');
    $('#instanceInstallProgressStatus').hidden=false;
    $('#instanceInstallProgressTitle').textContent='Minecraft could not start';
    $('#instanceInstallProgressStatus').textContent=e.message;
    clearTimeout(installProgressTimer);
    installProgressTimer=setTimeout(()=>{$('#instanceInstallProgress').hidden=true;},8000);
    renderInstances();
    renderQuick();
    showInstanceNotice(`Could not launch Minecraft: ${e.message}`);
  }
}

function updateLaunchStatus(status){
  const instance=instances.find(item=>item.folder===status.folder);
  if(instance){
    if(Number.isFinite(status.playtimeMs))instance.playtimeMs=status.playtimeMs;
    if(Number.isFinite(status.lastPlayed))instance.lastPlayed=status.lastPlayed;
  }
  if(status.state==='preparing'||status.state==='loading'){
    launchingInstanceFolder=status.folder;
    renderInstances();
    renderQuick();
    renderPlaytimeSettings();
    return;
  }
  if(status.state==='playing'){
    launchingInstanceFolder=null;
    playingInstanceFolder=status.folder;
    $('#instanceInstallProgress').hidden=true;
    renderInstances();
    renderQuick();
    renderPlaytimeSettings();
    return;
  }
  if(status.state==='failed'||status.state==='closed'){
    const wasPlaying=playingInstanceFolder===status.folder;
    const wasLoading=launchingInstanceFolder===status.folder;
    launchingInstanceFolder=null;
    playingInstanceFolder=null;
    $('#instanceInstallProgress').hidden=true;
    renderInstances();
    renderQuick();
    renderPlaytimeSettings();
    if(status.state==='failed')showInstanceNotice(`Minecraft could not start: ${status.message||'Unknown launch error.'}`);
    else if((wasPlaying||wasLoading)&&status.code!=null&&status.code!==0)showInstanceNotice(`Minecraft closed with exit code ${status.code}. Check the instance's latest.log for details.`);
  }
}

function renderQuick(){
  const pinned=pinnedInstanceFolders.map(folder=>instances.find(instance=>instance.folder===folder&&instance.installed)).filter(Boolean);
  $('#quickLaunch').innerHTML=pinned.length?pinned.map(instance=>{
    const active=playingInstanceFolder===instance.folder;
    const busy=Boolean(launchingInstanceFolder||playingInstanceFolder);
    return `<article class="quick-pin-item"><b class="quick-instance-name"><span>${escapeHtml(instance.name||instance.folder)}</span>${instanceIconMarkup(instance)}</b>${instanceMetaMarkup(instance)}<button class="play${active||busy?' is-busy':''}" data-folder="${escapeHtml(instance.folder)}" ${busy?'disabled':''}>${active?'PLAYING':launchingInstanceFolder===instance.folder?'LOADING…':'▶ PLAY'}</button></article>`;
  }).join(''):'<div class="quick-empty">No pinned instance</div>';
  $$('#quickLaunch .play').forEach(button=>button.onclick=()=>launch(button.dataset.folder));
}

async function togglePinnedInstance(folder){
  const instance=instances.find(item=>item.folder===folder);
  if(!instance?.installed){
    showInstanceNotice('Install this instance before pinning it to Quick Launch.');
    return;
  }
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
  if(skinViewer){
    skinViewer.viewer.renderPaused=b.dataset.page!=='profile';
    if(b.dataset.page==='profile')requestAnimationFrame(skinViewer.resize);
  }
  if(b.dataset.page==='mods')refreshInstalledMods();
  clearTimeout(pageAnimationTimer);
  if(pageAnimationDuration>0){
    void nextPage.offsetWidth;
    nextPage.classList.add('page-enter');
    pageAnimationTimer=setTimeout(()=>nextPage.classList.remove('page-enter'),pageAnimationDuration+50);
  }
});

$('#search').oninput=renderInstances;
$('#sort').onchange=renderInstances;
$('#selectedInstancePlay').onclick=()=>{
  const instance=instances.find(item=>item.folder===selectedInstanceFolder);
  if(!instance)return;
  if(instance.installed===false)installInstance(instance.folder);
  else launch(instance.folder);
};
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
$('#showPlaytimeToggle').onchange=async e=>{
  try{
    const settings=await window.eclipse.settings.set({showPlaytime:e.target.checked});
    showPlaytime=settings.showPlaytime!==false;
    e.target.checked=showPlaytime;
    renderSelectedInstance();
  }catch(error){
    e.target.checked=showPlaytime;
    showInstanceNotice(`Could not save the playtime display setting: ${error.message}`);
  }
};
$('#playtimePosition').onchange=async e=>{
  const previous=playtimePosition;
  try{
    const settings=await window.eclipse.settings.set({playtimePosition:e.target.value});
    playtimePosition=settings.playtimePosition==='right'?'right':'left';
    e.target.value=playtimePosition;
    syncCustomDropdown('playtimePosition');
    $('.selected-instance-bar').classList.toggle('playtime-right',playtimePosition==='right');
  }catch(error){
    e.target.value=previous;
    syncCustomDropdown('playtimePosition');
    showInstanceNotice(`Could not save the playtime position: ${error.message}`);
  }
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
$('#showFriendsBoxToggle').onchange=async e=>{
  const show=e.target.checked;
  try{
    const settings=await window.eclipse.settings.set({showFriendsBox:show});
    const visible=settings.showFriendsBox!==false;
    e.target.checked=visible;
    $('#friendsBox').hidden=!visible;
  }catch(error){
    e.target.checked=!$('#friendsBox').hidden;
    showInstanceNotice(`Could not save the Friends box setting: ${error.message}`);
  }
};
$('#showQuickLaunchToggle').onchange=async e=>{
  const show=e.target.checked;
  try{
    const settings=await window.eclipse.settings.set({showQuickLaunch:show});
    const visible=settings.showQuickLaunch!==false;
    e.target.checked=visible;
    $('#quickLaunchPanel').hidden=!visible;
  }catch(error){
    e.target.checked=!$('#quickLaunchPanel').hidden;
    showInstanceNotice(`Could not save the Quick Launch setting: ${error.message}`);
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
$('#resetPlaytimeCancel').onclick=closeResetPlaytimeDialog;
$('#resetPlaytimeConfirm').onclick=confirmResetPlaytime;
$('#resetPlaytimeDialog').onclick=event=>{
  if(event.target.id==='resetPlaytimeDialog')closeResetPlaytimeDialog();
};
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
    renderPlaytimeSettings();
  }catch(error){
    $('#renameInstanceError').textContent=error.message;
    $('#renameInstanceError').hidden=false;
    $('#renameInstanceInput').focus();
  }finally{button.disabled=false;}
};
$('#deleteInstanceCancel').onclick=closeDeleteInstanceDialog;
$('#deleteInstanceConfirm').onclick=confirmDeleteInstance;
$('#deleteInstanceDialog').onclick=event=>{
  if(event.target.id==='deleteInstanceDialog')closeDeleteInstanceDialog();
};
$('#deleteInstanceFinalCancel').onclick=closeDeleteInstanceDialog;
$('#deleteInstanceFinalConfirm').onclick=performDeleteInstance;
$('#deleteInstanceFinalDialog').onclick=event=>{
  if(event.target.id==='deleteInstanceFinalDialog')closeDeleteInstanceDialog();
};
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!$('#resetPlaytimeDialog').hidden)closeResetPlaytimeDialog();
  if(event.key==='Escape'&&!$('#removeProfileDialog').hidden)closeRemoveProfileDialog();
  if(event.key==='Escape'&&!$('#renameInstanceDialog').hidden)closeRenameInstanceDialog();
  if(event.key==='Escape'&&!$('#deleteInstanceDialog').hidden)closeDeleteInstanceDialog();
  if(event.key==='Escape'&&!$('#deleteInstanceFinalDialog').hidden)closeDeleteInstanceDialog();
  if(event.key==='Escape'&&!$('#removeModDialog').hidden)closeRemoveModDialog();
  if(event.key==='Enter'&&!$('#renameInstanceDialog').hidden&&document.activeElement===$('#renameInstanceInput'))$('#renameInstanceSave').click();
});

setupCustomDropdowns();
window.eclipse.instances.onInstallProgress(updateInstanceInstallProgress);
window.eclipse.instances.onLaunchStatus(updateLaunchStatus);
window.eclipse.mods.onInstallProgress(updateModInstallProgress);
init();
