import test from "node:test";
import assert from "node:assert/strict";
import { emptyProduction, type ProductionScene } from "./production-types";
import { openingHistory, approveOpeningCandidate, queueOpeningCandidates, nextProductionTask } from "./production-opening-history";

function fixture(){
  const state=emptyProduction();
  const scene:ProductionScene={sceneNumber:1,title:"Bay",location:"Bay",timeOfDay:"Day",characters:[],action:"Waves",dialogue:""};
  state.story.scenes=[scene];
  return {state,scene};
}
test("batch generation retains the current approved image and independently tracks each version",()=>{
  const {state,scene}=fixture();
  scene.opening={assetId:"approved",mediaUrl:"/approved",sourceKey:"inputs",status:"READY",approvedAssetId:"approved"};
  queueOpeningCandidates(state,scene,"inputs",4);
  assert.equal(scene.opening.assetId,"approved");
  assert.equal(scene.opening.approvedAssetId,"approved");
  assert.equal(scene.openingHistory?.length,5);
  assert.equal(state.tasks.length,4);
  assert.equal(new Set(state.tasks.map(t=>t.id)).size,4);
  assert.ok(state.tasks.every(t=>Number.isInteger(t.openingSeed)&&t.openingSeed!>=0&&t.status==="QUEUED"));
  assert.equal(new Set(scene.openingHistory?.slice(1).map(item=>item.id)).size,4);
});
test("different scenes can queue openings before earlier versions finish",()=>{
  const {state,scene}=fixture();
  queueOpeningCandidates(state,scene,"one",2);
  state.tasks[0].status="RUNNING";state.tasks[0].jobId="existing-job";
  const second:ProductionScene={...scene,sceneNumber:2,opening:undefined,openingHistory:undefined};
  state.story.scenes.push(second);
  queueOpeningCandidates(state,second,"two",2);
  assert.equal(state.tasks.length,4);
  assert.equal(second.openingHistory?.length,2);
  assert.equal(state.tasks[0].jobId,"existing-job");
});
test("a completed older version can be approved while newer versions are running",()=>{
  const {state,scene}=fixture();
  scene.opening={assetId:"old",mediaUrl:"/old",sourceKey:"same",status:"READY"};
  queueOpeningCandidates(state,scene,"same",2);
  scene.openingHistory!.push({assetId:"new",mediaUrl:"/new",sourceKey:"same",status:"READY"});
  approveOpeningCandidate(scene,"old","same");
  assert.equal(scene.opening.approvedAssetId,"old");
  assert.equal(scene.opening.mediaUrl,"/old");
  approveOpeningCandidate(scene,"new","same");
  assert.equal(scene.opening.approvedAssetId,"new");
});
test("approval rejects stale, foreign, missing and unfinished candidates",()=>{
  const {scene}=fixture();
  scene.openingHistory=[
    {assetId:"stale",sourceKey:"old",status:"READY"},
    {assetId:"pending",sourceKey:"current",status:"RUNNING"},
  ];
  for(const id of ["stale","pending","foreign",undefined])assert.throws(()=>approveOpeningCandidate(scene,id,"current"),/Choose a completed/);
});
test("queue count validation is atomic and preserves correction sources",()=>{
  const {state,scene}=fixture();
  for(const count of [0,5,1.5,"2"])assert.throws(()=>queueOpeningCandidates(state,scene,"same",count));
  assert.equal(state.tasks.length,0);
  assert.throws(()=>queueOpeningCandidates(state,scene,"same",2,"Change pose"),/before correcting/);
  scene.opening={assetId:"source",sourceKey:"same",status:"READY"};
  queueOpeningCandidates(state,scene,"same",2,"Change pose");
  assert.ok(state.tasks.every(t=>t.openingReferenceAssetId==="source"&&t.openingCorrection==="Change pose"));
  for(let n=0;n<4;n++)queueOpeningCandidates(state,scene,"same",4);
  assert.equal(state.tasks.length,18);
  assert.throws(()=>queueOpeningCandidates(state,scene,"same",4),/Up to 20/);
  assert.equal(state.tasks.length,18);
});
test("dispatcher rotates submissions and polls so one running version cannot block others",()=>{
  const {state,scene}=fixture();
  queueOpeningCandidates(state,scene,"same",3);
  const first=nextProductionTask(state.tasks)!;
  first.status="RUNNING";first.jobId="job";
  const second=nextProductionTask(state.tasks,first.id)!;
  assert.equal(second.id,state.tasks[1].id);
  const third=nextProductionTask(state.tasks,second.id)!;
  assert.equal(third.id,state.tasks[2].id);
  assert.equal(nextProductionTask(state.tasks,third.id)?.id,first.id);
  first.status="COMPLETED";
  assert.equal(nextProductionTask(state.tasks,first.id)?.id,second.id);
  for(const task of state.tasks)task.status="COMPLETED";
  assert.equal(nextProductionTask(state.tasks),undefined);
});
test("legacy selected openings are retained once, not duplicated on repeated reads",()=>{
  const {scene}=fixture();
  scene.opening={assetId:"legacy",sourceKey:"key",status:"READY"};
  openingHistory(scene);openingHistory(scene);
  assert.equal(scene.openingHistory?.length,1);
});
