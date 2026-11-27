globalThis.websiteBundle = (() => {
  try {
    return [
      '(function(){var H="<body style=background:#111;color:#0f0;padding:20px><h1>源加载成功</h1><p id=r>正在测试接口线程…</p>";var d=document;d.open();d.write(H);d.close();setTimeout(function(){fetch("http://127.0.0.1:5321/proxy?url="+encodeURIComponent("https://cms.lyyytv.cn/api.php/app/nav?token=")).then(function(r){return r.text();}).then(function(t){document.getElementById("r").textContent="接口通路 OK，返回 "+t.length+" 字节";}).catch(function(e){document.getElementById("r").textContent="接口请求失败："+e;});},400);})();'
    ].join('');
  } catch (e) { return ''; }
})();
