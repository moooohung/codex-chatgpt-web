import {test,expect} from 'bun:test';
import {EventEmitter} from 'node:events';
const {NativePlatform,NativeView}=require('../launcher/native-webview2/native-platform.cjs');

test('closing a controller during creation cancels queued presentation without sending commands to a released target',async()=>{
  let finishCreation:(value:object)=>void=()=>{};
  const calls:string[]=[],errors:string[]=[];
  const client=Object.assign(new EventEmitter(),{
    addTab:()=>new Promise(resolve=>{finishCreation=resolve;}),
    request:async(operation:string)=>{calls.push(operation);return {ok:true,result:{}};},
    setLease:async(_id:string,leased:boolean)=>{calls.push('lease:'+leased);},
    closeTab:async()=>{calls.push('close');},
  });
  const platform=new NativePlatform(client,{onError:(error:Error)=>errors.push(error.message)});
  const view=new NativeView(platform);
  view.setBounds({x:0,y:0,width:800,height:600});view.setVisible(true);
  view.webContents.setZoomFactor(1.25);view.webContents.focus();
  const closed=view.webContents.close();
  finishCreation({targetId:'offline-owned-target'});
  await closed;await platform.flush();
  expect(calls.filter(call=>['bounds','zoom','action'].includes(call))).toEqual([]);
  expect(calls.filter(call=>call==='close')).toHaveLength(1);
  expect(calls.at(-2)).toBe('lease:false');expect(calls.at(-1)).toBe('close');
  expect(errors).toEqual([]);expect(platform.views.size).toBe(0);expect(view.webContents.session.views.size).toBe(0);
});
