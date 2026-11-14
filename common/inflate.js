
/* ===== [兼容] 无 DecompressionStream 时的纯 JS inflate 回退 ==== */
/* 精简 inflate（RFC1951 DEFLATE 解压）── 用于不支持 DecompressionStream 的旧 WebView。
   输入 Uint8Array（自动识别 gzip 头），输出 Uint8Array。无依赖、无 eval。 */
(function (root) {
  var LBASE=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  var LEXT =[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  var DBASE=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  var DEXT =[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  var CLORDER=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  function Reader(d,p0){this.d=d;this.p=p0;this.bb=0;this.bc=0;}
  Reader.prototype.bits=function(n){
    while(this.bc<n){ this.bb |= this.d[this.p++]<<this.bc; this.bc+=8; }
    var v=this.bb & ((1<<n)-1); this.bb>>>=n; this.bc-=n; return v;
  };
  Reader.prototype.align=function(){ this.bb=0; this.bc=0; };

  // 用「按长度分桶的数组」加速解码：tree = {counts:[], symbols:[]}（canonical Huffman）
  function buildTree(lengths,n){
    var MAXB=15, counts=new Int32Array(MAXB+1), i;
    for(i=0;i<n;i++) counts[lengths[i]]++;
    counts[0]=0;
    var offs=new Int32Array(MAXB+2);
    for(i=1;i<=MAXB;i++) offs[i+1]=offs[i]+counts[i];
    var symbols=new Int32Array(n);
    var idx=offs.slice(0);
    for(i=0;i<n;i++){ var l=lengths[i]; if(l) symbols[idx[l]++]=i; }
    return {offs:offs, symbols:symbols};
  }
  function decodeSym(br,t){
    var code=0, first=0, index=0;
    for(var len=1;len<=15;len++){
      code |= br.bits(1);
      var count=t.offs[len+1]-t.offs[len];
      if(code < first+count) return t.symbols[t.offs[len]+(code-first)];
      index+=count; first=(first+count)<<1; code<<=1;
    }
    throw new Error("inflate: 无效霍夫曼编码");
  }

  function inflateRaw(d){
    var br=new Reader(d,0);
    var cap=1<<20, out=new Uint8Array(cap), olen=0;
    function need(k){
      if(olen+k<=cap) return;
      while(olen+k>cap){ cap*=2; if(cap>1<<28) throw new Error("inflate: 输出过大"); }
      var nb=new Uint8Array(cap); nb.set(out.subarray(0,olen)); out=nb;
    }
    var last,type;
    do{
      last=br.bits(1); type=br.bits(2);
      if(type===0){
        br.align();
        var len=br.bits(16), nlen=br.bits(16);
        if((len^0xFFFF)!==nlen) throw new Error("inflate: stored 长度校验失败");
        need(len);
        for(var q=0;q<len;q++) out[olen++]=br.bits(8);
      } else if(type===1||type===2){
        var nlen2,ndist,lengths;
        if(type===1){
          nlen2=288; ndist=30;
          lengths=new Uint8Array(320);
          var i;
          for(i=0;i<144;i++) lengths[i]=8;
          for(;i<256;i++) lengths[i]=9;
          for(;i<280;i++) lengths[i]=7;
          for(;i<288;i++) lengths[i]=8;
          for(i=288;i<320;i++) lengths[i]=5;
        } else {
          nlen2=br.bits(5)+257; ndist=br.bits(5)+1;
          var ncode=br.bits(4)+4;
          lengths=new Uint8Array(320);
          var cl=new Uint8Array(19);
          for(var j=0;j<ncode;j++) cl[CLORDER[j]]=br.bits(3);
          var clT=buildTree(cl,19);
          var idx=0;
          while(idx<nlen2+ndist){
            var sym=decodeSym(br,clT);
            if(sym<16) lengths[idx++]=sym;
            else{
              var prev=0,rep=0;
              if(sym===16){ if(idx===0) throw new Error("inflate: 无效重复"); prev=lengths[idx-1]; rep=3+br.bits(2); }
              else if(sym===17) rep=3+br.bits(3);
              else rep=11+br.bits(7);
              if(idx+rep>nlen2+ndist) throw new Error("inflate: 长度越界");
              for(var k=0;k<rep;k++) lengths[idx++]=prev;
            }
          }
        }
        var lt=buildTree(lengths.subarray(0,nlen2),nlen2);
        var dt=buildTree(lengths.subarray(nlen2,nlen2+ndist),ndist);
        for(;;){
          var s=decodeSym(br,lt);
          if(s===256) break;
          if(s<256){ need(1); out[olen++]=s; }
          else{
            s-=257;
            if(s>=29) throw new Error("inflate: 无效长度码");
            var L=LBASE[s]+br.bits(LEXT[s]);
            var ds=decodeSym(br,dt);
            var D=DBASE[ds]+br.bits(DEXT[ds]);
            if(D>olen) throw new Error("inflate: 距离超出窗口");
            need(L);
            var st=olen-D;
            for(var m=0;m<L;m++) out[olen++]=out[st+m];
          }
        }
      } else throw new Error("inflate: 无效块类型");
    } while(!last);
    return out.subarray(0,olen);
  }

  function gunzip(u8){
    if(u8[0]!==0x1f||u8[1]!==0x8b) return inflateRaw(u8);
    var p=10, flg=u8[3];
    if(flg&4){ var xl=u8[p]|(u8[p+1]<<8); p+=2+xl; }
    if(flg&8){ while(u8[p]) p++; p++; }
    if(flg&16){ while(u8[p]) p++; p++; }
    if(flg&2) p+=2;
    return inflateRaw(u8.subarray(p,u8.length-8));
  }
  root.__gunzipU8=gunzip;
  root.__gunzipText=function(u8){
    var raw=gunzip(u8);
    if(typeof TextDecoder!=="undefined") return new TextDecoder("utf-8").decode(raw);
    var s="",CH=32768;
    for(var i=0;i<raw.length;i+=CH) s+=String.fromCharCode.apply(null,raw.subarray(i,i+CH));
    return decodeURIComponent(escape(s));
  };
})(typeof window!=="undefined"?window:this);

