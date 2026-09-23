/* Galleros Live Chess — authenticated Gmail edition */
// Filled silhouettes keep the white set readable on ivory squares across fonts/browsers.
const PIECES={wp:'♟',wn:'♞',wb:'♝',wr:'♜',wq:'♛',wk:'♚',bp:'♟',bn:'♞',bb:'♝',br:'♜',bq:'♛',bk:'♚'};
const FILES=['a','b','c','d','e','f','g','h'];
const cfg=window.CHESS_CONFIG||{};
const db=(window.supabase&&cfg.supabaseUrl&&cfg.supabaseKey)?window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseKey):null;

const $=id=>document.getElementById(id);
const boardEl=$('board'),statusEl=$('gameStatus'),moveHistoryEl=$('moveHistory'),emptyMovesEl=$('emptyMoves');
const thinkingEl=$('thinking'),difficultyEl=$('difficulty'),playerColorEl=$('playerColor'),gameIdEl=$('gameId'),puzzlePhaseEl=$('puzzlePhase');
const turnDotEl=$('turnDot'),opponentNameEl=$('opponentName'),opponentSubEl=$('opponentSub'),youSubEl=$('youSub');
const toastEl=$('toast'),connectionStatus=$('connectionStatus');

let game=new Chess();
let selected=null,legalTargets=[],lastMove=null,resigned=false,aiBusy=false;
let mode='computer',playerColor='w',orientation='w';
let session=null,profile=null;
let live={code:null,color:null,ply:0,status:null,channel:null,stake:200};
let puzzles=[],currentPuzzle=null,puzzleIndex=0,puzzleSolutionIndex=0,puzzlePlayerColor='w',puzzleStreak=0,puzzleRecentIds=[];
let stockfishWorker=null,stockfishReady=null,stockfishSearch=null;
const STOCKFISH_URL='./vendor/stockfish/stockfish.js';

function toast(message){toastEl.textContent=message;toastEl.classList.add('show');setTimeout(()=>toastEl.classList.remove('show'),2200)}
function cleanError(err){
  const m=(err?.message||String(err||'Something went wrong')).replace('new row violates row-level security policy for table ','');
  if(m.includes('LOGIN_REQUIRED'))return 'Please log in first.';
  if(m.includes('GMAIL_REQUIRED'))return 'Only verified @gmail.com accounts are allowed.';
  if(m.includes('VERIFY_GMAIL'))return 'Verify your Gmail first, then log in again.';
  if(m.includes('Rating')&&m.includes('required'))return m.replace('P0001: ','');
  return m.replace(/^P0001:\s*/,'');
}
async function rpc(name,args={}){const {data,error}=await db.rpc(name,args);if(error)throw error;return data}
function requireAuth(){if(!session){$('authGate').classList.remove('hidden');toast('Login with Gmail first');return false}return true}

// ---------- Auth ----------
async function googleLogin(){
  if(!db)return setAuthMessage('Database is not configured.','error');
  const btn=$('googleLoginBtn');btn.disabled=true;btn.textContent='Opening Google…';
  const redirectTo=`${window.location.origin}${window.location.pathname}`;
  const {error}=await db.auth.signInWithOAuth({
    provider:'google',
    options:{redirectTo,queryParams:{prompt:'select_account'}}
  });
  if(error){
    btn.disabled=false;btn.innerHTML='<span class="google-g">G</span> Continue with Google';
    const msg=(error.message||'').toLowerCase().includes('provider')
      ? 'Google sign-in is not enabled yet in Supabase. Enable the Google provider first.'
      : cleanError(error);
    return setAuthMessage(msg,'error');
  }
}
function gmailValid(email){return /^[^@\s]+@gmail\.com$/i.test((email||'').trim())}
function setAuthMessage(msg,type=''){const el=$('authMessage');el.textContent=msg;el.className='auth-message'+(type?` ${type}`:'')}
async function signUp(){
  if(!db)return setAuthMessage('Database is not configured.','error');
  const email=$('authEmail').value.trim().toLowerCase(),password=$('authPassword').value;
  if(!gmailValid(email))return setAuthMessage('Use an active @gmail.com address.','error');
  if(password.length<6)return setAuthMessage('Password must be at least 6 characters.','error');
  $('signupBtn').disabled=true;
  const {data,error}=await db.auth.signUp({email,password});
  $('signupBtn').disabled=false;
  if(error)return setAuthMessage(cleanError(error),'error');
  if(data.session){await handleSession(data.session)}
  else setAuthMessage('Account created. Check Gmail and verify the email, then return here and log in.','success');
}
async function login(){
  if(!db)return setAuthMessage('Database is not configured.','error');
  const email=$('authEmail').value.trim().toLowerCase(),password=$('authPassword').value;
  if(!gmailValid(email))return setAuthMessage('Use your @gmail.com address.','error');
  $('loginBtn').disabled=true;
  const {data,error}=await db.auth.signInWithPassword({email,password});
  $('loginBtn').disabled=false;
  if(error)return setAuthMessage(cleanError(error),'error');
  await handleSession(data.session);
}
async function requestPasswordReset(){
  if(!db)return setAuthMessage('Database is not configured.','error');
  const email=$('authEmail').value.trim().toLowerCase();
  if(!gmailValid(email))return setAuthMessage('Enter your @gmail.com address first.','error');
  const btn=$('forgotPasswordBtn');btn.disabled=true;btn.textContent='Sending reset link…';
  let {error}=await db.auth.resetPasswordForEmail(email,{redirectTo:`${window.location.origin}${window.location.pathname}`});
  if(error&&/redirect/i.test(error.message||'')){({error}=await db.auth.resetPasswordForEmail(email));}
  btn.disabled=false;btn.textContent='Forgot password? Send reset link';
  if(error)return setAuthMessage(cleanError(error),'error');
  setAuthMessage('Password reset email sent. Open Gmail, tap the reset link, then choose a new chess password.','success');
}
async function completePasswordRecovery(){
  const next=window.prompt('Enter a NEW password for Galleros Live Chess (at least 6 characters):');
  if(next===null)return setAuthMessage('Password reset not completed. You can use Forgot password again.','');
  if(next.length<6){setAuthMessage('New password must be at least 6 characters.','error');return setTimeout(completePasswordRecovery,50)}
  const {error}=await db.auth.updateUser({password:next});
  if(error)return setAuthMessage(cleanError(error),'error');
  setAuthMessage('Password changed successfully. You can use the new password next time you log in.','success');
  toast('Password changed successfully');
}
async function logout(){
  stopLiveSubscription();
  await db?.auth.signOut();
  session=null;profile=null;live={code:null,color:null,ply:0,status:null,channel:null,stake:200};
  $('authGate').classList.remove('hidden');$('accountEmail').classList.add('hidden');$('logoutBtn').classList.add('hidden');
  setAuthMessage('Logged out. Continue with Google to sign in again.');
}
async function handleSession(nextSession){
  session=nextSession||null;
  if(!session){$('authGate').classList.remove('hidden');return}
  const u=session.user;
  if(!gmailValid(u.email)||!u.email_confirmed_at){
    await db.auth.signOut();session=null;
    $('authGate').classList.remove('hidden');
    return setAuthMessage('Your Gmail must be verified before you can play.','error');
  }
  $('authGate').classList.add('hidden');
  $('accountEmail').textContent=`✓ ${u.email}`;$('accountEmail').classList.remove('hidden');$('logoutBtn').classList.remove('hidden');
  connectionStatus.textContent='● Online · Gmail verified';
  if($('playerName').value==='Player'||!$('playerName').value.trim()) $('playerName').value=(u.email.split('@')[0]||'Player').slice(0,20);
  try{await ensureProfile();await refreshLeaderboard();await loadPuzzles();}
  catch(e){toast(cleanError(e))}
}
async function ensureProfile(){
  if(!session)return null;
  let rows=await rpc('chess_auth_profile');
  if(!rows?.length){
    const name=($('playerName').value.trim()||session.user.email.split('@')[0]).slice(0,20);
    await rpc('chess_auth_register_player',{p_name:name});
    rows=await rpc('chess_auth_profile');
  }
  profile=rows[0]||null;renderProfile();return profile;
}
async function savePlayerName(){
  if(!requireAuth())return null;
  const name=$('playerName').value.trim().slice(0,20);
  if(!name)throw new Error('Enter a player name.');
  await rpc('chess_auth_register_player',{p_name:name});
  return ensureProfile();
}
function renderProfile(){
  $('myRating').textContent=profile?.rating??1500;$('profileRating').textContent=profile?.rating??1500;
  $('myRank').textContent=profile?.rank?`#${profile.rank}`:'—';$('profileGames').textContent=profile?.games??0;
  $('profileWdl').textContent=profile?`${profile.wins}-${profile.draws}-${profile.losses}`:'0-0-0';
}

// ---------- Board ----------
function squareOrder(){
  const ranks=orientation==='w'?[8,7,6,5,4,3,2,1]:[1,2,3,4,5,6,7,8];
  const files=orientation==='w'?FILES:[...FILES].reverse();
  return ranks.flatMap(r=>files.map(f=>`${f}${r}`));
}
function renderBoard(){
  boardEl.innerHTML='';const order=squareOrder();
  order.forEach((sq,idx)=>{
    const file=sq.charCodeAt(0)-97,rank=Number(sq[1]);
    const cell=document.createElement('button');cell.type='button';cell.className=`square ${(file+rank)%2===1?'light':'dark'}`;cell.dataset.square=sq;
    if(selected===sq)cell.classList.add('selected');if(lastMove&&(lastMove.from===sq||lastMove.to===sq))cell.classList.add('last-move');
    const legal=legalTargets.find(m=>m.to===sq);if(legal)cell.classList.add(game.get(sq)?'capture-target':'legal-target');
    const p=game.get(sq);if(p){const span=document.createElement('span');span.className=`piece color-${p.color} type-${p.type}`;span.setAttribute('aria-label',`${p.color==='w'?'White':'Black'} ${p.type}`);span.textContent=PIECES[p.color+p.type];cell.appendChild(span)}
    if(idx%8===0){const r=document.createElement('span');r.className='coord rank';r.textContent=sq[1];cell.appendChild(r)}
    if(idx>=56){const f=document.createElement('span');f.className='coord file';f.textContent=sq[0];cell.appendChild(f)}
    cell.addEventListener('click',()=>handleSquareClick(sq));boardEl.appendChild(cell);
  });renderInfo();
}
function canSelectPiece(piece){
  if(!piece||piece.color!==game.turn())return false;
  if(mode==='computer')return piece.color===playerColor&&game.turn()===playerColor&&!aiBusy;
  if(mode==='live')return live.status==='active'&&piece.color===live.color&&game.turn()===live.color;
  if(mode==='puzzle')return piece.color===puzzlePlayerColor&&game.turn()===puzzlePlayerColor;
  return false;
}
async function handleSquareClick(square){
  if(resigned||game.game_over())return;
  const piece=game.get(square);
  if(!selected){if(canSelectPiece(piece))selectSquare(square);return}
  if(square===selected){clearSelection();return}
  const target=legalTargets.find(m=>m.to===square);
  if(target){
    const beforeFen=game.fen();const beforePgn=game.pgn();
    const move=game.move({from:selected,to:square,promotion:'q'});
    if(!move)return;
    lastMove={from:move.from,to:move.to};clearSelection(false);renderBoard();
    if(mode==='live')await submitLiveMove(move,beforeFen,beforePgn);
    else if(mode==='puzzle')await checkPuzzleMove(move);
    else if(mode==='computer'&&!game.game_over())setTimeout(computerTurn,280);
    return;
  }
  if(canSelectPiece(piece))selectSquare(square);else clearSelection();
}
function selectSquare(square){selected=square;legalTargets=game.moves({square,verbose:true});renderBoard()}
function clearSelection(render=true){selected=null;legalTargets=[];if(render)renderBoard()}
function isMyTurn(){
  if(mode==='computer')return game.turn()===playerColor&&!aiBusy;
  if(mode==='live')return live.status==='active'&&game.turn()===live.color;
  if(mode==='puzzle')return game.turn()===puzzlePlayerColor;
  return false;
}
function renderInfo(){
  const turn=game.turn()==='w'?'White':'Black';let text=`${turn} to move`;
  if(mode==='live'&&live.status==='waiting')text='Waiting for opponent…';
  else if(resigned)text='Game over · Resigned';
  else if(game.in_checkmate())text=`Checkmate · ${turn==='White'?'Black':'White'} wins`;
  else if(game.in_draw())text='Draw';else if(game.in_check())text=`${turn} is in check`;
  if(mode==='live'&&live.status&&['white_won','black_won','draw','resigned_white','resigned_black'].includes(live.status)){
    const map={white_won:'White wins',black_won:'Black wins',draw:'Draw',resigned_white:'White resigned · Black wins',resigned_black:'Black resigned · White wins'};text=`Game over · ${map[live.status]}`;
  }
  statusEl.textContent=text;turnDotEl.style.opacity=isMyTurn()&&!game.game_over()?'1':'.25';
  const history=game.history();moveHistoryEl.innerHTML='';emptyMovesEl.style.display=history.length?'none':'block';
  for(let i=0;i<history.length;i+=2){const n=document.createElement('div');n.className='move-no';n.textContent=`${i/2+1}.`;const w=document.createElement('div');w.className='move-cell';w.textContent=history[i]||'';const b=document.createElement('div');b.className='move-cell';b.textContent=history[i+1]||'';moveHistoryEl.append(n,w,b)}
}

// ---------- Computer ----------
const value={p:100,n:320,b:330,r:500,q:900,k:20000};
function ensureStockfish(){
  if(stockfishWorker)return stockfishReady;
  stockfishReady=new Promise((resolve,reject)=>{
    let settled=false;
    try{
      stockfishWorker=new Worker(STOCKFISH_URL);
      stockfishWorker.onmessage=e=>{
        const line=String(e.data||'');
        if(line.includes('uciok')&&!settled){settled=true;resolve(stockfishWorker)}
        if(line.startsWith('bestmove ')&&stockfishSearch){
          const search=stockfishSearch;stockfishSearch=null;search.resolve(line.split(/\s+/)[1]);
        }
      };
      stockfishWorker.onerror=error=>{
        if(!settled){settled=true;reject(error)}
        if(stockfishSearch){const search=stockfishSearch;stockfishSearch=null;search.reject(error)}
        stockfishWorker=null;stockfishReady=null;
      };
      stockfishWorker.postMessage('uci');
    }catch(error){stockfishWorker=null;stockfishReady=null;reject(error)}
  });
  return stockfishReady;
}
async function stockfishMove(){
  const worker=await ensureStockfish();
  const level=difficultyEl.value;
  const skill=level==='hard'?18:level==='medium'?10:3;
  const movetime=level==='hard'?2200:level==='medium'?1100:450;
  worker.postMessage('setoption name Skill Level value '+skill);
  worker.postMessage('position fen '+game.fen());
  return await new Promise((resolve,reject)=>{
    stockfishSearch={resolve,reject};
    worker.postMessage(`go movetime ${movetime}`);
    setTimeout(()=>{if(stockfishSearch){const search=stockfishSearch;stockfishSearch=null;search.reject(new Error('Stockfish timed out'))}},movetime+2500);
  });
}
function evaluateBoard(){let score=0;for(let r=1;r<=8;r++)for(const f of FILES){const p=game.get(`${f}${r}`);if(p)score+=(p.color==='b'?1:-1)*value[p.type]}return score}
function shuffle(arr){const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function minimax(depth,alpha,beta,maxBlack){if(depth===0||game.game_over())return evaluateBoard();const moves=game.moves({verbose:true});if(maxBlack){let best=-Infinity;for(const m of moves){game.move(m);best=Math.max(best,minimax(depth-1,alpha,beta,false));game.undo();alpha=Math.max(alpha,best);if(beta<=alpha)break}return best}let best=Infinity;for(const m of moves){game.move(m);best=Math.min(best,minimax(depth-1,alpha,beta,true));game.undo();beta=Math.min(beta,best);if(beta<=alpha)break}return best}
function pickComputerMove(){let moves=game.moves({verbose:true});if(!moves.length)return null;const level=difficultyEl.value;if(level==='easy')return shuffle(moves)[0];const black=playerColor==='w',depth=level==='hard'?2:1;let best=null,bestScore=black?-Infinity:Infinity;moves=shuffle(moves);for(const m of moves){game.move(m);let score=minimax(depth-1,-Infinity,Infinity,!black);game.undo();if(m.captured)score+=(black?1:-1)*value[m.captured]*.2;score+=(Math.random()-.5)*(level==='medium'?24:6);if((black&&score>bestScore)||(!black&&score<bestScore)){bestScore=score;best=m}}return best||moves[0]}
async function computerTurn(){
  if(game.game_over()||resigned||mode!=='computer'||game.turn()===playerColor)return;
  aiBusy=true;thinkingEl.classList.remove('hidden');renderInfo();
  try{
    let uci;
    try{uci=await stockfishMove()}catch(error){console.warn('Stockfish unavailable; using local fallback.',error);uci=null}
    const m0=uci&&uci!=='(none)'?{from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]||'q'}:pickComputerMove();
    if(m0){const m=game.move(m0);if(m)lastMove={from:m.from,to:m.to}}
  }finally{aiBusy=false;thinkingEl.classList.add('hidden');renderBoard()}
}
function newComputerGame(){game=new Chess();resigned=false;selected=null;legalTargets=[];lastMove=null;aiBusy=false;playerColor=playerColorEl.value;orientation=playerColor;opponentNameEl.textContent=`Computer · ${difficultyEl.value[0].toUpperCase()+difficultyEl.value.slice(1)}`;opponentSubEl.textContent=playerColor==='w'?'Black':'White';youSubEl.textContent=playerColor==='w'?'White':'Black';gameIdEl.textContent='LOCAL';clearAnalysis();renderBoard();if(playerColor==='b')setTimeout(computerTurn,350)}

// ---------- Live ----------
function generateRoomCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<6;i++)s+=chars[Math.floor(Math.random()*chars.length)];return s}
function stopLiveSubscription(){if(live.channel&&db){db.removeChannel(live.channel).catch(()=>{});live.channel=null}}
function subscribeRoom(code){
  stopLiveSubscription();
  live.channel=db.channel(`chess-room-${code}`).on('postgres_changes',{event:'INSERT',schema:'public',table:'chess_room_events',filter:`room_code=eq.${code}`},payload=>{
    const row=payload.new;if(row){applyLivePayload(row,false);if(row.event_type==='finished'){ensureProfile().then(refreshLeaderboard).catch(()=>{})}}
  }).subscribe();
}
async function applyLivePayload(row,withColor=true){
  if(withColor&&row.color)live.color=row.color;live.code=row.room_code||live.code;live.ply=Number(row.ply||0);live.status=row.status||live.status;
  const g=new Chess();let loaded=false;if(row.pgn){try{loaded=g.load_pgn(row.pgn)||false}catch{}}
  if(!loaded&&row.fen&&row.fen!=='start'){try{loaded=g.load(row.fen)}catch{}}
  game=loaded?g:new Chess();resigned=false;selected=null;legalTargets=[];lastMove=null;playerColor=live.color||'w';orientation=live.color||'w';
  const white=row.white_name||'White',black=row.black_name||'Waiting…';
  if(live.color==='w'){opponentNameEl.textContent=black;opponentSubEl.textContent='Black';youSubEl.textContent='White'}else{opponentNameEl.textContent=white;opponentSubEl.textContent='White';youSubEl.textContent='Black'}
  gameIdEl.textContent=live.code||'LIVE';$('roomCodeText').textContent=live.code||'------';$('roomBox').classList.toggle('hidden',!live.code);
  if(live.code){try{const s=await rpc('chess_auth_room_stake',{p_room_code:live.code});if(s?.[0])live.stake=s[0].rating_stake}catch{}}
  $('liveHelper').textContent=live.status==='waiting'?`Room ${live.code} · waiting for opponent · ${live.stake} rating points at stake`:`Room ${live.code} · ${live.stake} rating points at stake`;
  clearAnalysis();renderBoard();
}
async function createRoom(){
  if(!requireAuth())return;try{await savePlayerName();const code=generateRoomCode();const stake=Math.max(10,Math.min(1000,Number($('ratingStake').value)||200));const rows=await rpc('chess_auth_create_room',{p_name:$('playerName').value.trim(),p_room_code:code,p_rating_stake:stake});if(!rows?.length)throw new Error('Could not create room');live.stake=stake;await applyLivePayload(rows[0],true);subscribeRoom(code);toast(`Room ${code} created`)}catch(e){toast(cleanError(e))}
}
async function joinRoom(codeOverride=null){
  if(!requireAuth())return;const code=(codeOverride||$('roomCodeInput').value).trim().toUpperCase();if(!code)return toast('Enter a room code');
  try{await savePlayerName();const rows=await rpc('chess_auth_join_room',{p_name:$('playerName').value.trim(),p_room_code:code});if(!rows?.length)throw new Error('Room not found');await applyLivePayload(rows[0],true);subscribeRoom(code);toast(`Joined ${code}`)}catch(e){toast(cleanError(e))}
}
async function openRoom(code){
  if(!requireAuth())return;try{const rows=await rpc('chess_auth_get_room',{p_room_code:code});if(!rows?.length)throw new Error('This room is not assigned to your account');switchMode('live',false);await applyLivePayload(rows[0],true);subscribeRoom(code)}catch(e){toast(cleanError(e))}
}
async function refreshLiveRoom(){if(!live.code)return;try{const rows=await rpc('chess_auth_get_room',{p_room_code:live.code});if(rows?.length)await applyLivePayload(rows[0],true)}catch(e){console.warn(e)}}
async function submitLiveMove(move,beforeFen,beforePgn){
  if(!live.code)return;
  try{
    const rows=await rpc('chess_auth_submit_move',{p_room_code:live.code,p_expected_ply:live.ply,p_from:move.from,p_to:move.to,p_san:move.san,p_fen:game.fen(),p_pgn:game.pgn(),p_next_turn:game.turn()});
    if(rows?.length){live.ply=rows[0].ply;live.status=rows[0].status}
    if(game.in_checkmate()){await rpc('chess_auth_finish_room',{p_room_code:live.code,p_result:move.color==='w'?'white_won':'black_won'});await refreshLiveRoom();await ensureProfile();await refreshLeaderboard()}
    else if(game.in_draw()){await rpc('chess_auth_finish_room',{p_room_code:live.code,p_result:'draw'});await refreshLiveRoom();await ensureProfile();await refreshLeaderboard()}
  }catch(e){const restore=new Chess();if(beforePgn){try{restore.load_pgn(beforePgn)}catch{restore.load(beforeFen)}}else restore.load(beforeFen);game=restore;toast(`Move not saved: ${cleanError(e)}`);await refreshLiveRoom();renderBoard()}
}
async function resignGame(){
  if(game.game_over())return;
  if(mode==='live'&&live.code&&live.status==='active'){
    try{await rpc('chess_auth_finish_room',{p_room_code:live.code,p_result:live.color==='w'?'resigned_white':'resigned_black'});toast('You resigned');await refreshLiveRoom();await ensureProfile();await refreshLeaderboard()}catch(e){toast(cleanError(e))}
  }else if(mode==='computer'){resigned=true;renderInfo();toast('Game resigned')}
}

// ---------- Puzzles ----------
const builtInPuzzles=[
  {id:'opening-italian-development',title:'Italian Development',difficulty:'easy',phase:'opening',fen:'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',solution:['f1c4'],hint:'Develop the bishop toward the king and fight for the center.',theme:'Development'},
  {id:'opening-center-break',title:'Open the Center',difficulty:'medium',phase:'opening',fen:'r1bqk2r/pppp1ppp/2n2n2/4p3/2BPP3/5N2/PPP2PPP/RNBQ1RK1 w kq - 3 5',solution:['d4e5'],hint:'Exchange in the center before Black completes development.',theme:'Central break'},
  {id:'opening-castle',title:'Castle to Safety',difficulty:'easy',phase:'opening',fen:'r1bqk2r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPP2PPP/RNBQ1RK1 w kq - 4 6',solution:['f1e1'],hint:'Improve the rook and keep pressure on the open file.',theme:'King safety'},
  {id:'middlegame-fork',title:'Knight Fork',difficulty:'medium',phase:'middlegame',fen:'4k3/8/3q4/8/4N3/8/8/4K3 w - - 0 1',solution:['e4f6'],hint:'Find the knight jump that attacks the king and queen.',theme:'Fork'},
  {id:'middlegame-back-rank',title:'Back Rank Pressure',difficulty:'hard',phase:'middlegame',fen:'3r2k1/5ppp/8/8/8/5Q2/5PPP/3R2K1 w - - 0 1',solution:['f3d3'],hint:'Double your pressure before the final back-rank blow.',theme:'Attack'},
  {id:'middlegame-queen-finish',title:'Queen Finish',difficulty:'easy',phase:'middlegame',fen:'7k/6pp/5Q2/8/8/8/6PP/6K1 w - - 0 1',solution:['f6d8'],hint:'The queen can finish the attack from the diagonal.',theme:'Mate in 1'},
  {id:'endgame-rook-mate',title:'Rook on the Back Rank',difficulty:'easy',phase:'endgame',fen:'6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',solution:['d1d8'],hint:'Use the open file to give check on the eighth rank.',theme:'Mate in 1'},
  {id:'endgame-promotion',title:'Passed Pawn',difficulty:'medium',phase:'endgame',fen:'8/4P3/8/8/8/8/4k3/4K3 w - - 0 1',solution:['e7e8'],hint:'Advance the passed pawn and promote immediately.',theme:'Promotion'},
  {id:'endgame-smothered-net',title:'Smothered Net',difficulty:'hard',phase:'endgame',fen:'6rk/5Qpp/7N/8/8/8/6PP/6K1 w - - 0 1',solution:['f7g8'],hint:'The knight blocks the king’s escape squares.',theme:'Mate in 1'}
];
function puzzlePhase(puzzle){
  if(puzzle.phase)return puzzle.phase;
  const theme=String(puzzle.theme||'').toLowerCase();
  if(/opening|develop|castle|center/.test(theme))return 'opening';
  if(/endgame|promotion|pawn|back rank/.test(theme))return 'endgame';
  return 'middlegame';
}
async function loadPuzzles(){
  if(!session)return;
  const {data,error}=await db.from('chess_puzzles').select('*').order('id');
  if(error)throw error;
  const remote=(data||[]).map(p=>({...p,phase:puzzlePhase(p)}));
  const remoteThemes=new Set(remote.map(p=>`${p.title}|${p.fen}`));
  puzzles=[...remote,...builtInPuzzles.filter(p=>!remoteThemes.has(`${p.title}|${p.fen}`))];
}
function parseUci(uci){return{from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]||'q'}}
async function nextPuzzle(){
  if(!requireAuth())return;
  if(!puzzles.length)await loadPuzzles();
  const diff=$('puzzleDifficulty').value,phase=puzzlePhaseEl.value;
  let pool=puzzles.filter(p=>(diff==='all'||p.difficulty===diff)&&(phase==='all'||puzzlePhase(p)===phase));
  if(!pool.length)return toast('No puzzles in this phase and level yet');
  let fresh=pool.filter(p=>!puzzleRecentIds.includes(String(p.id)));
  if(!fresh.length){puzzleRecentIds=[];fresh=pool}
  currentPuzzle=fresh[Math.floor(Math.random()*fresh.length)];
  puzzleRecentIds.push(String(currentPuzzle.id));if(puzzleRecentIds.length>Math.max(4,Math.min(12,pool.length-1)))puzzleRecentIds.shift();
  puzzleIndex++;puzzleSolutionIndex=0;game=new Chess();if(!game.load(currentPuzzle.fen))game=new Chess();puzzlePlayerColor=game.turn();playerColor=puzzlePlayerColor;orientation=puzzlePlayerColor;resigned=false;selected=null;legalTargets=[];lastMove=null;
  $('puzzleTheme').textContent=`${puzzlePhase(currentPuzzle)} · ${currentPuzzle.theme} · ${currentPuzzle.difficulty}`;$('puzzleHint').classList.add('hidden');$('puzzleHint').textContent=currentPuzzle.hint;gameIdEl.textContent=`PUZZLE ${currentPuzzle.id}`;opponentNameEl.textContent='Puzzle';opponentSubEl.textContent=`${puzzlePhase(currentPuzzle)[0].toUpperCase()+puzzlePhase(currentPuzzle).slice(1)} · Find the best move`;youSubEl.textContent=puzzlePlayerColor==='w'?'White to solve':'Black to solve';clearAnalysis('Solve the puzzle first.');renderBoard();
}
async function checkPuzzleMove(move){
  if(!currentPuzzle)return;const expected=currentPuzzle.solution[puzzleSolutionIndex];const uci=`${move.from}${move.to}${move.promotion||''}`;const basic=`${move.from}${move.to}`;
  if(!expected||(uci!==expected&&basic!==expected)){game.undo();lastMove=null;renderBoard();toast('Try again');return}
  puzzleSolutionIndex++;
  if(puzzleSolutionIndex>=currentPuzzle.solution.length){puzzleStreak++;$('puzzleStreak').textContent=puzzleStreak;toast('Puzzle solved ✓');setTimeout(nextPuzzle,700);return}
  // Auto-play opponent reply when the solution line contains it.
  if(game.turn()!==puzzlePlayerColor){const reply=parseUci(currentPuzzle.solution[puzzleSolutionIndex]);const m=game.move(reply);if(m){lastMove={from:m.from,to:m.to};puzzleSolutionIndex++;renderBoard()}if(puzzleSolutionIndex>=currentPuzzle.solution.length){puzzleStreak++;$('puzzleStreak').textContent=puzzleStreak;toast('Puzzle solved ✓');setTimeout(nextPuzzle,700)}}
}

// ---------- Leaderboard / invites / tournament ----------
async function refreshLeaderboard(){
  if(!session)return;try{const rows=await rpc('chess_auth_leaderboard',{p_limit:10});const root=$('leaderboardRows');root.innerHTML='';(rows||[]).forEach(r=>{const row=document.createElement('div');row.className='leaderboard-row';row.innerHTML=`<span class="rank-medal">${r.rank}</span><span class="leaderboard-player"><span class="leaderboard-name"></span><div class="leaderboard-record">${r.wins}-${r.draws}-${r.losses} · ${r.games} games</div></span><span class="leaderboard-rating">${r.rating}</span>`;row.querySelector('.leaderboard-name').textContent=r.display_name;root.appendChild(row)});if(!rows?.length)root.innerHTML='<div class="empty-state" style="padding:10px">No ranked players yet.</div>'}catch(e){toast(cleanError(e))}
}
async function refreshMembers(){
  if(!session)return;
  try{
    const q=$('memberSearch')?.value.trim()||'';
    const [total,rows]=await Promise.all([
      rpc('chess_auth_member_count'),
      rpc('chess_auth_members',{p_query:q})
    ]);
    $('totalMembers').textContent=Number(total||0).toLocaleString();
    const root=$('membersRows');root.innerHTML='';
    (rows||[]).forEach(r=>{
      const row=document.createElement('div');row.className='member-row';
      row.innerHTML=`<span class="rank-medal">${r.rank}</span><span class="leaderboard-player"><span class="leaderboard-name"></span><div class="leaderboard-record">${r.games} games · W ${r.wins} · D ${r.draws} · L ${r.losses}</div></span><span class="leaderboard-rating">${r.rating}</span>`;
      row.querySelector('.leaderboard-name').textContent=r.display_name;
      root.appendChild(row);
    });
    if(!rows?.length)root.innerHTML='<div class="empty-state" style="padding:10px">No members found.</div>';
  }catch(e){toast(cleanError(e))}
}

async function searchPlayers(){
  if(!requireAuth())return;const q=$('inviteSearch').value.trim();try{const rows=await rpc('chess_auth_search_players',{p_query:q});const root=$('inviteSearchResults');root.innerHTML='';(rows||[]).forEach(r=>{const el=document.createElement('div');el.className='stack-item';el.innerHTML=`<div class="stack-item-head"><div><div class="stack-title"></div><div class="stack-meta">#${r.rank} · rating ${r.rating} · ${r.games} games</div></div><span class="badge">Ranked</span></div><div class="stack-actions"><button class="primary" style="width:auto;margin:0">Invite</button></div>`;el.querySelector('.stack-title').textContent=r.display_name;el.querySelector('button').onclick=()=>sendInvite(r.player_id,r.display_name);root.appendChild(el)});if(!rows?.length)root.innerHTML='<div class="empty-state">No players found.</div>'}catch(e){toast(cleanError(e))}
}
async function sendInvite(playerId,name){
  try{const stake=Math.max(10,Math.min(1000,Number($('ratingStake').value)||200));await rpc('chess_auth_invite_player',{p_invitee_player_id:playerId,p_rating_stake:stake});toast(`Invite sent to ${name} · ${stake} points`);await refreshInvites()}catch(e){toast(cleanError(e))}
}
async function refreshInvites(){
  if(!session)return;try{const rows=await rpc('chess_auth_my_invites');const root=$('myInvitesList');root.innerHTML='';(rows||[]).forEach(r=>{const el=document.createElement('div');el.className='stack-item';const who=r.direction==='received'?'From':'To';el.innerHTML=`<div class="stack-item-head"><div><div class="stack-title"></div><div class="stack-meta">${r.rating_stake} rating points · ${r.status}</div></div><span class="badge">${r.direction}</span></div><div class="stack-actions"></div>`;el.querySelector('.stack-title').textContent=`${who} ${r.other_player_name} (${r.other_player_rating})`;const actions=el.querySelector('.stack-actions');if(r.status==='pending'&&r.direction==='received'){const a=document.createElement('button');a.className='primary';a.style.cssText='width:auto;margin:0';a.textContent='Accept';a.onclick=()=>respondInvite(r.invite_id,true);const d=document.createElement('button');d.textContent='Decline';d.onclick=()=>respondInvite(r.invite_id,false);actions.append(a,d)}else if(r.status==='pending'){const c=document.createElement('button');c.textContent='Cancel';c.onclick=()=>cancelInvite(r.invite_id);actions.append(c)}else if(r.status==='accepted'&&r.room_code){const o=document.createElement('button');o.className='primary';o.style.cssText='width:auto;margin:0';o.textContent='Open match';o.onclick=()=>openRoom(r.room_code);actions.append(o)}root.appendChild(el)});if(!rows?.length)root.innerHTML='<div class="empty-state">No invites yet.</div>'}catch(e){toast(cleanError(e))}
}
async function respondInvite(id,accept){try{const rows=await rpc('chess_auth_respond_invite',{p_invite_id:id,p_accept:accept});if(accept&&rows?.[0]?.room_code){toast('Challenge accepted');await openRoom(rows[0].room_code)}else toast('Invite declined');await refreshInvites()}catch(e){toast(cleanError(e))}}
async function cancelInvite(id){try{await rpc('chess_auth_cancel_invite',{p_invite_id:id});toast('Invite cancelled');await refreshInvites()}catch(e){toast(cleanError(e))}}
async function refreshTournament(){
  if(!session)return;try{const rows=await rpc('chess_auth_tournament_list');const t=rows?.[0];const card=$('tournamentCard'),details=$('tournamentDetails');details.innerHTML='';if(!t){card.textContent='No tournament available.';return}const eligible=t.eligible;card.innerHTML=`<strong>${escapeHtml(t.name)}</strong><br>Minimum rating: ${t.min_rating} · ${t.joined}/${t.max_players} players · ${t.status}<br>Your rating: ${t.player_rating??'—'}<div class="stack-actions" id="tourActions"></div>`;const actions=$('tourActions');if(t.already_joined){const b=document.createElement('span');b.className='badge';b.textContent='Registered';actions.appendChild(b)}else if(eligible){const b=document.createElement('button');b.className='primary';b.style.cssText='width:auto;margin:0';b.textContent='Join Elite 3500+';b.onclick=()=>joinTournament(t.tournament_id);actions.appendChild(b)}else{const b=document.createElement('span');b.className='badge';b.textContent=(t.player_rating??0)<t.min_rating?'Not eligible yet':'Registration unavailable';actions.appendChild(b)}
    const [entries,bracket,myMatch]=await Promise.all([rpc('chess_auth_tournament_entries',{p_tournament_id:t.tournament_id}),rpc('chess_auth_tournament_bracket',{p_tournament_id:t.tournament_id}),rpc('chess_auth_my_tournament_match')]);
    if(entries?.length){const e=document.createElement('div');e.className='stack-item';e.innerHTML='<div class="stack-title">Entrants</div><div class="stack-meta"></div>';e.querySelector('.stack-meta').textContent=entries.map(x=>`${x.seed?`#${x.seed} `:''}${x.display_name} (${x.rating})`).join(' · ');details.appendChild(e)}
    (bracket||[]).forEach(m=>{const e=document.createElement('div');e.className='stack-item';e.innerHTML=`<div class="stack-title">Round ${m.round_no} · Match ${m.match_no}</div><div class="stack-meta"></div>`;e.querySelector('.stack-meta').textContent=`${m.white_name||'TBD'} vs ${m.black_name||'TBD'} · ${m.winner_name?`Winner: ${m.winner_name}`:m.status}`;details.appendChild(e)});
    if(myMatch?.[0]?.room_code&&myMatch[0].match_status==='active'){const m=myMatch[0];const e=document.createElement('div');e.className='stack-item';e.innerHTML=`<div class="stack-title">Your tournament match</div><div class="stack-meta">Round ${m.round_no} · vs ${escapeHtml(m.opponent_name)} · ${m.rating_stake} points</div><div class="stack-actions"><button class="primary" style="width:auto;margin:0">Open match</button></div>`;e.querySelector('button').onclick=()=>openRoom(m.room_code);details.prepend(e)}
  }catch(e){toast(cleanError(e))}
}
async function joinTournament(id){try{await rpc('chess_auth_join_tournament',{p_tournament_id:id});toast('Joined Elite Tournament');await refreshTournament()}catch(e){toast(cleanError(e))}}
function escapeHtml(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}

// ---------- Modes ----------
function switchMode(next,reset=true){
  mode=next;['computer','live','puzzle'].forEach(x=>{$(`${x}ModeBtn`).classList.toggle('active',next===x);$(`${x}Controls`).classList.toggle('hidden',next!==x)});
  stopLiveSubscription();
  if(next==='computer'){if(reset)newComputerGame()}
  else if(next==='live'){if(reset){game=new Chess();resigned=false;lastMove=null;selected=null;legalTargets=[];live={code:null,color:'w',ply:0,status:null,channel:null,stake:200};orientation='w';opponentNameEl.textContent='Waiting for opponent';opponentSubEl.textContent='Live room';youSubEl.textContent='White';gameIdEl.textContent='LIVE';$('roomBox').classList.add('hidden');$('liveHelper').textContent='Create a room, join by code, or accept an invite.';clearAnalysis();renderBoard()}}
  else if(next==='puzzle'){nextPuzzle().catch(e=>toast(cleanError(e)))}
}

// ---------- Analysis ----------
const ANALYSIS_VALUES={p:100,n:320,b:330,r:500,q:900,k:0};const analysisBtn=$('analyzeBtn'),analysisSummaryEl=$('analysisSummary'),analysisResultsEl=$('analysisResults');
function clearAnalysis(message='Play a few moves, then tap Analyze.'){analysisSummaryEl.textContent=message;analysisResultsEl.innerHTML=''}
function positionalBonus(piece,sq){const file=sq.charCodeAt(0)-97,rank=Number(sq[1])-1,center=Math.abs(file-3.5)+Math.abs(rank-3.5);let bonus=Math.max(0,4-center)*3;if(piece.type==='p')bonus+=(piece.color==='w'?rank:7-rank)*2;if(piece.type==='n'||piece.type==='b')bonus*=1.4;return bonus}
function evaluateFor(g,perspective){if(g.in_checkmate())return g.turn()===perspective?-100000:100000;if(g.in_draw())return 0;let score=0;for(let r=1;r<=8;r++)for(const f of FILES){const sq=`${f}${r}`,p=g.get(sq);if(p){const n=ANALYSIS_VALUES[p.type]+positionalBonus(p,sq);score+=p.color===perspective?n:-n}}if(g.in_check())score+=g.turn()===perspective?-28:28;return score}
function searchFor(g,depth,a,b,perspective){if(depth===0||g.game_over())return evaluateFor(g,perspective);const max=g.turn()===perspective,moves=g.moves({verbose:true});if(max){let best=-Infinity;for(const m of moves){g.move(m);best=Math.max(best,searchFor(g,depth-1,a,b,perspective));g.undo();a=Math.max(a,best);if(b<=a)break}return best}let best=Infinity;for(const m of moves){g.move(m);best=Math.min(best,searchFor(g,depth-1,a,b,perspective));g.undo();b=Math.min(b,best);if(b<=a)break}return best}
function analyzeChoice(g,actualSan,perspective,depth=2){const moves=g.moves({verbose:true});if(!moves.length)return null;let best=null,bestScore=-Infinity,actualScore=null;for(const m of moves){g.move(m);const score=searchFor(g,depth-1,-Infinity,Infinity,perspective);g.undo();if(score>bestScore){bestScore=score;best=m}if(m.san===actualSan)actualScore=score}return{bestSan:best?.san||'',bestScore,actualScore:actualScore??bestScore,loss:Math.max(0,bestScore-(actualScore??bestScore))}}
function classifyLoss(loss,a,b){if(a===b||loss<=14)return{label:'Best',cls:'best'};if(loss<=40)return{label:'Good',cls:'good'};if(loss<=85)return{label:'Inaccuracy',cls:'inaccuracy'};if(loss<=175)return{label:'Mistake',cls:'mistake'};return{label:'Blunder',cls:'blunder'}}
async function analyzeCurrentGame(){
  const sans=game.history();if(!sans.length)return toast('Play a few moves first');analysisBtn.disabled=true;analysisBtn.textContent='Analyzing…';analysisResultsEl.innerHTML='';analysisSummaryEl.textContent='Reviewing your moves…';const perspective=mode==='live'?(live.color||'w'):playerColor,replay=new Chess(),results=[];
  for(let i=0;i<sans.length;i++){const san=sans[i],movingColor=replay.turn();if(movingColor===perspective){const a=analyzeChoice(replay,san,perspective,2);if(a){const rating=classifyLoss(a.loss,san,a.bestSan);results.push({moveNo:Math.floor(i/2)+1,color:movingColor,san,bestSan:a.bestSan,loss:a.loss,...rating})}}replay.move(san,{sloppy:true});if(i%4===3)await new Promise(r=>setTimeout(r,0))}
  const bad=results.filter(r=>['inaccuracy','mistake','blunder'].includes(r.cls)),worst=[...bad].sort((a,b)=>b.loss-a.loss)[0];analysisSummaryEl.textContent=!results.length?'No moves from your side yet.':!bad.length?'Strong game — no major mistakes found in this quick review.':`Found ${bad.length} move${bad.length===1?'':'s'} to review. Biggest issue: ${worst.moveNo}${worst.color==='b'?'…':'.'} ${worst.san}; ${worst.bestSan} was stronger.`;
  results.forEach(r=>{const item=document.createElement('div');item.className='analysis-item';item.innerHTML=`<div class="analysis-ply">${r.color==='w'?`${r.moveNo}.`:`${r.moveNo}…`}</div><div class="analysis-main"><div class="analysis-move"></div><div class="analysis-tip"></div></div><div class="analysis-badge ${r.cls}">${r.label}</div>`;item.querySelector('.analysis-move').textContent=r.san;item.querySelector('.analysis-tip').textContent=(r.cls==='best'||r.cls==='good')?'Solid choice in this position.':`Better: ${r.bestSan} · estimated loss ${Math.round(r.loss)} points`;analysisResultsEl.appendChild(item)});
  analysisBtn.disabled=false;analysisBtn.textContent='Analyze';
}

// ---------- UI wiring ----------
$('googleLoginBtn').addEventListener('click',googleLogin);$('loginBtn').addEventListener('click',login);$('signupBtn').addEventListener('click',signUp);$('logoutBtn').addEventListener('click',logout);
$('authPassword').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
$('computerModeBtn').addEventListener('click',()=>switchMode('computer'));$('liveModeBtn').addEventListener('click',()=>{if(requireAuth())switchMode('live')});$('puzzleModeBtn').addEventListener('click',()=>{if(requireAuth())switchMode('puzzle')});
$('newComputerGame').addEventListener('click',newComputerGame);difficultyEl.addEventListener('change',()=>{opponentNameEl.textContent=`Computer · ${difficultyEl.value[0].toUpperCase()+difficultyEl.value.slice(1)}`});
$('createRoomBtn').addEventListener('click',createRoom);$('joinRoomBtn').addEventListener('click',()=>joinRoom());$('roomCodeInput').addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom()});
$('copyRoomBtn').addEventListener('click',async()=>{const code=$('roomCodeText').textContent;try{await navigator.clipboard.writeText(code);toast('Room code copied')}catch{toast(code)}});
$('flipBtn').addEventListener('click',()=>{orientation=orientation==='w'?'b':'w';renderBoard()});
$('undoBtn').addEventListener('click',()=>{if(mode!=='computer')return toast(mode==='live'?'Undo is disabled in rated live games.':'Use Try again in puzzles.');if(game.history().length){game.undo();if(game.turn()!==playerColor&&game.history().length)game.undo();lastMove=null;resigned=false;renderBoard()}});
$('resignBtn').addEventListener('click',resignGame);$('resetBtn').addEventListener('click',()=>{if(mode==='computer')newComputerGame();else if(mode==='puzzle')nextPuzzle();else toast('Create, join, or accept a new live match.')});
$('hintBtn').addEventListener('click',()=>{if(currentPuzzle)$('puzzleHint').classList.toggle('hidden')});$('nextPuzzleBtn').addEventListener('click',nextPuzzle);$('puzzleDifficulty').addEventListener('change',nextPuzzle);puzzlePhaseEl.addEventListener('change',nextPuzzle);
$('refreshLeaderboardBtn').addEventListener('click',refreshLeaderboard);$('refreshMembersBtn').addEventListener('click',refreshMembers);$('searchMembersBtn').addEventListener('click',refreshMembers);$('memberSearch').addEventListener('keydown',e=>{if(e.key==='Enter')refreshMembers()});$('searchPlayersBtn').addEventListener('click',searchPlayers);$('inviteSearch').addEventListener('keydown',e=>{if(e.key==='Enter')searchPlayers()});$('refreshInvitesBtn').addEventListener('click',refreshInvites);$('refreshTournamentBtn').addEventListener('click',refreshTournament);analysisBtn.addEventListener('click',analyzeCurrentGame);
document.querySelectorAll('.info-tab').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.info-tab').forEach(b=>b.classList.toggle('active',b===btn));['moves','leaderboard','members','invites','tournament'].forEach(x=>$(`${x}Panel`).classList.toggle('hidden',btn.dataset.info!==x));if(btn.dataset.info==='leaderboard')refreshLeaderboard();if(btn.dataset.info==='members')refreshMembers();if(btn.dataset.info==='invites')refreshInvites();if(btn.dataset.info==='tournament')refreshTournament()}));

// ---------- Boot ----------
(async function init(){
  newComputerGame();
  if(!db){connectionStatus.textContent='● Database unavailable';setAuthMessage('Database connection is unavailable.','error');return}
  connectionStatus.textContent='● Connecting…';
  db.auth.onAuthStateChange((event,next)=>{
    if(event==='PASSWORD_RECOVERY'){session=next;setTimeout(async()=>{await handleSession(next);await completePasswordRecovery()},0);return}
    if(event==='SIGNED_OUT'){session=null;$('authGate').classList.remove('hidden')}
    else if(next&&next.access_token!==session?.access_token){setTimeout(()=>handleSession(next),0)}
  });
  const {data}=await db.auth.getSession();await handleSession(data.session);
})();
