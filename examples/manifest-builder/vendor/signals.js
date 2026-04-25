// node_modules/@preact/signals/dist/signals.module.js
import { Component as i2, options as r2, isValidElement as n2 } from "preact";
import { useMemo as t2, useRef as f2, useEffect as o2 } from "preact/hooks";

// node_modules/@preact/signals-core/dist/signals-core.module.js
var i = /* @__PURE__ */ Symbol.for("preact-signals");
function t() {
  if (!(s > 1)) {
    var i3, t3 = false;
    !(function() {
      var i4 = c;
      c = void 0;
      while (void 0 !== i4) {
        if (i4.S.v === i4.v) i4.S.i = i4.i;
        i4 = i4.o;
      }
    })();
    while (void 0 !== h) {
      var n3 = h;
      h = void 0;
      v++;
      while (void 0 !== n3) {
        var r3 = n3.u;
        n3.u = void 0;
        n3.f &= -3;
        if (!(8 & n3.f) && w(n3)) try {
          n3.c();
        } catch (n4) {
          if (!t3) {
            i3 = n4;
            t3 = true;
          }
        }
        n3 = r3;
      }
    }
    v = 0;
    s--;
    if (t3) throw i3;
  } else s--;
}
function n(i3) {
  if (s > 0) return i3();
  e = ++u;
  s++;
  try {
    return i3();
  } finally {
    t();
  }
}
var r = void 0;
function o(i3) {
  var t3 = r;
  r = void 0;
  try {
    return i3();
  } finally {
    r = t3;
  }
}
var f;
var h = void 0;
var s = 0;
var v = 0;
var u = 0;
var e = 0;
var c = void 0;
var d = 0;
function a(i3) {
  if (void 0 !== r) {
    var t3 = i3.n;
    if (void 0 === t3 || t3.t !== r) {
      t3 = { i: 0, S: i3, p: r.s, n: void 0, t: r, e: void 0, x: void 0, r: t3 };
      if (void 0 !== r.s) r.s.n = t3;
      r.s = t3;
      i3.n = t3;
      if (32 & r.f) i3.S(t3);
      return t3;
    } else if (-1 === t3.i) {
      t3.i = 0;
      if (void 0 !== t3.n) {
        t3.n.p = t3.p;
        if (void 0 !== t3.p) t3.p.n = t3.n;
        t3.p = r.s;
        t3.n = void 0;
        r.s.n = t3;
        r.s = t3;
      }
      return t3;
    }
  }
}
function l(i3, t3) {
  this.v = i3;
  this.i = 0;
  this.n = void 0;
  this.t = void 0;
  this.l = 0;
  this.W = null == t3 ? void 0 : t3.watched;
  this.Z = null == t3 ? void 0 : t3.unwatched;
  this.name = null == t3 ? void 0 : t3.name;
}
l.prototype.brand = i;
l.prototype.h = function() {
  return true;
};
l.prototype.S = function(i3) {
  var t3 = this, n3 = this.t;
  if (n3 !== i3 && void 0 === i3.e) {
    i3.x = n3;
    this.t = i3;
    if (void 0 !== n3) n3.e = i3;
    else o(function() {
      var i4;
      null == (i4 = t3.W) || i4.call(t3);
    });
  }
};
l.prototype.U = function(i3) {
  var t3 = this;
  if (void 0 !== this.t) {
    var n3 = i3.e, r3 = i3.x;
    if (void 0 !== n3) {
      n3.x = r3;
      i3.e = void 0;
    }
    if (void 0 !== r3) {
      r3.e = n3;
      i3.x = void 0;
    }
    if (i3 === this.t) {
      this.t = r3;
      if (void 0 === r3) o(function() {
        var i4;
        null == (i4 = t3.Z) || i4.call(t3);
      });
    }
  }
};
l.prototype.subscribe = function(i3) {
  var t3 = this;
  return j(function() {
    var n3 = t3.value, o3 = r;
    r = void 0;
    try {
      i3(n3);
    } finally {
      r = o3;
    }
  }, { name: "sub" });
};
l.prototype.valueOf = function() {
  return this.value;
};
l.prototype.toString = function() {
  return this.value + "";
};
l.prototype.toJSON = function() {
  return this.value;
};
l.prototype.peek = function() {
  var i3 = r;
  r = void 0;
  try {
    return this.value;
  } finally {
    r = i3;
  }
};
Object.defineProperty(l.prototype, "value", { get: function() {
  var i3 = a(this);
  if (void 0 !== i3) i3.i = this.i;
  return this.v;
}, set: function(i3) {
  if (i3 !== this.v) {
    if (v > 100) throw new Error("Cycle detected");
    !(function(i4) {
      if (0 !== s && 0 === v) {
        if (i4.l !== e) {
          i4.l = e;
          c = { S: i4, v: i4.v, i: i4.i, o: c };
        }
      }
    })(this);
    this.v = i3;
    this.i++;
    d++;
    s++;
    try {
      for (var n3 = this.t; void 0 !== n3; n3 = n3.x) n3.t.N();
    } finally {
      t();
    }
  }
} });
function y(i3, t3) {
  return new l(i3, t3);
}
function w(i3) {
  for (var t3 = i3.s; void 0 !== t3; t3 = t3.n) if (t3.S.i !== t3.i || !t3.S.h() || t3.S.i !== t3.i) return true;
  return false;
}
function _(i3) {
  for (var t3 = i3.s; void 0 !== t3; t3 = t3.n) {
    var n3 = t3.S.n;
    if (void 0 !== n3) t3.r = n3;
    t3.S.n = t3;
    t3.i = -1;
    if (void 0 === t3.n) {
      i3.s = t3;
      break;
    }
  }
}
function b(i3) {
  var t3 = i3.s, n3 = void 0;
  while (void 0 !== t3) {
    var r3 = t3.p;
    if (-1 === t3.i) {
      t3.S.U(t3);
      if (void 0 !== r3) r3.n = t3.n;
      if (void 0 !== t3.n) t3.n.p = r3;
    } else n3 = t3;
    t3.S.n = t3.r;
    if (void 0 !== t3.r) t3.r = void 0;
    t3 = r3;
  }
  i3.s = n3;
}
function p(i3, t3) {
  l.call(this, void 0);
  this.x = i3;
  this.s = void 0;
  this.g = d - 1;
  this.f = 4;
  this.W = null == t3 ? void 0 : t3.watched;
  this.Z = null == t3 ? void 0 : t3.unwatched;
  this.name = null == t3 ? void 0 : t3.name;
}
p.prototype = new l();
p.prototype.h = function() {
  this.f &= -3;
  if (1 & this.f) return false;
  if (32 == (36 & this.f)) return true;
  this.f &= -5;
  if (this.g === d) return true;
  this.g = d;
  this.f |= 1;
  if (this.i > 0 && !w(this)) {
    this.f &= -2;
    return true;
  }
  var i3 = r;
  try {
    _(this);
    r = this;
    var t3 = this.x();
    if (16 & this.f || this.v !== t3 || 0 === this.i) {
      this.v = t3;
      this.f &= -17;
      this.i++;
    }
  } catch (i4) {
    this.v = i4;
    this.f |= 16;
    this.i++;
  }
  r = i3;
  b(this);
  this.f &= -2;
  return true;
};
p.prototype.S = function(i3) {
  if (void 0 === this.t) {
    this.f |= 36;
    for (var t3 = this.s; void 0 !== t3; t3 = t3.n) t3.S.S(t3);
  }
  l.prototype.S.call(this, i3);
};
p.prototype.U = function(i3) {
  if (void 0 !== this.t) {
    l.prototype.U.call(this, i3);
    if (void 0 === this.t) {
      this.f &= -33;
      for (var t3 = this.s; void 0 !== t3; t3 = t3.n) t3.S.U(t3);
    }
  }
};
p.prototype.N = function() {
  if (!(2 & this.f)) {
    this.f |= 6;
    for (var i3 = this.t; void 0 !== i3; i3 = i3.x) i3.t.N();
  }
};
Object.defineProperty(p.prototype, "value", { get: function() {
  if (1 & this.f) throw new Error("Cycle detected");
  var i3 = a(this);
  this.h();
  if (void 0 !== i3) i3.i = this.i;
  if (16 & this.f) throw this.v;
  return this.v;
} });
function g(i3, t3) {
  return new p(i3, t3);
}
function S(i3) {
  var n3 = i3.m;
  i3.m = void 0;
  if ("function" == typeof n3) {
    s++;
    var o3 = r;
    r = void 0;
    try {
      n3();
    } catch (t3) {
      i3.f &= -2;
      i3.f |= 8;
      m(i3);
      throw t3;
    } finally {
      r = o3;
      t();
    }
  }
}
function m(i3) {
  for (var t3 = i3.s; void 0 !== t3; t3 = t3.n) t3.S.U(t3);
  i3.x = void 0;
  i3.s = void 0;
  S(i3);
}
function x(i3) {
  if (r !== this) throw new Error("Out-of-order effect");
  b(this);
  r = i3;
  this.f &= -2;
  if (8 & this.f) m(this);
  t();
}
function E(i3, t3) {
  this.x = i3;
  this.m = void 0;
  this.s = void 0;
  this.u = void 0;
  this.f = 32;
  this.name = null == t3 ? void 0 : t3.name;
  if (f) f.push(this);
}
E.prototype.c = function() {
  var i3 = this.S();
  try {
    if (8 & this.f) return;
    if (void 0 === this.x) return;
    var t3 = this.x();
    if ("function" == typeof t3) this.m = t3;
  } finally {
    i3();
  }
};
E.prototype.S = function() {
  if (1 & this.f) throw new Error("Cycle detected");
  this.f |= 1;
  this.f &= -9;
  S(this);
  _(this);
  s++;
  var i3 = r;
  r = this;
  return x.bind(this, i3);
};
E.prototype.N = function() {
  if (!(2 & this.f)) {
    this.f |= 2;
    this.u = h;
    h = this;
  }
};
E.prototype.d = function() {
  this.f |= 8;
  if (!(1 & this.f)) m(this);
};
E.prototype.dispose = function() {
  this.d();
};
function j(i3, t3) {
  var n3 = new E(i3, t3);
  try {
    n3.c();
  } catch (i4) {
    n3.d();
    throw i4;
  }
  var r3 = n3.d.bind(n3);
  r3[Symbol.dispose] = r3;
  return r3;
}

// node_modules/@preact/signals/dist/signals.module.js
var v2;
var s2;
function l2(i3, n3) {
  r2[i3] = n3.bind(null, r2[i3] || function() {
  });
}
function d2(i3) {
  if (s2) {
    var r3 = s2;
    s2 = void 0;
    r3();
  }
  s2 = i3 && i3.S();
}
function h2(i3) {
  var r3 = this, f3 = i3.data, o3 = useSignal(f3);
  o3.value = f3;
  var e2 = t2(function() {
    var i4 = r3.__v;
    while (i4 = i4.__) if (i4.__c) {
      i4.__c.__$f |= 4;
      break;
    }
    r3.__$u.c = function() {
      var i5, t3 = r3.__$u.S(), f4 = e2.value;
      t3();
      if (n2(f4) || 3 !== (null == (i5 = r3.base) ? void 0 : i5.nodeType)) {
        r3.__$f |= 1;
        r3.setState({});
      } else r3.base.data = f4;
    };
    return g(function() {
      var i5 = o3.value.value;
      return 0 === i5 ? 0 : true === i5 ? "" : i5 || "";
    });
  }, []);
  return e2.value;
}
h2.displayName = "_st";
Object.defineProperties(l.prototype, { constructor: { configurable: true, value: void 0 }, type: { configurable: true, value: h2 }, props: { configurable: true, get: function() {
  return { data: this };
} }, __b: { configurable: true, value: 1 } });
l2("__b", function(i3, r3) {
  if ("string" == typeof r3.type) {
    var n3, t3 = r3.props;
    for (var f3 in t3) if ("children" !== f3) {
      var o3 = t3[f3];
      if (o3 instanceof l) {
        if (!n3) r3.__np = n3 = {};
        n3[f3] = o3;
        t3[f3] = o3.peek();
      }
    }
  }
  i3(r3);
});
l2("__r", function(i3, r3) {
  i3(r3);
  d2();
  var n3, t3 = r3.__c;
  if (t3) {
    t3.__$f &= -2;
    if (void 0 === (n3 = t3.__$u)) t3.__$u = n3 = (function(i4) {
      var r4;
      j(function() {
        r4 = this;
      });
      r4.c = function() {
        t3.__$f |= 1;
        t3.setState({});
      };
      return r4;
    })();
  }
  v2 = t3;
  d2(n3);
});
l2("__e", function(i3, r3, n3, t3) {
  d2();
  v2 = void 0;
  i3(r3, n3, t3);
});
l2("diffed", function(i3, r3) {
  d2();
  v2 = void 0;
  var n3;
  if ("string" == typeof r3.type && (n3 = r3.__e)) {
    var t3 = r3.__np, f3 = r3.props;
    if (t3) {
      var o3 = n3.U;
      if (o3) for (var e2 in o3) {
        var u2 = o3[e2];
        if (void 0 !== u2 && !(e2 in t3)) {
          u2.d();
          o3[e2] = void 0;
        }
      }
      else n3.U = o3 = {};
      for (var a2 in t3) {
        var c2 = o3[a2], s3 = t3[a2];
        if (void 0 === c2) {
          c2 = p2(n3, a2, s3, f3);
          o3[a2] = c2;
        } else c2.o(s3, f3);
      }
    }
  }
  i3(r3);
});
function p2(i3, r3, n3, t3) {
  var f3 = r3 in i3 && void 0 === i3.ownerSVGElement, o3 = y(n3);
  return { o: function(i4, r4) {
    o3.value = i4;
    t3 = r4;
  }, d: j(function() {
    var n4 = o3.value.value;
    if (t3[r3] !== n4) {
      t3[r3] = n4;
      if (f3) i3[r3] = n4;
      else if (n4) i3.setAttribute(r3, n4);
      else i3.removeAttribute(r3);
    }
  }) };
}
l2("unmount", function(i3, r3) {
  if ("string" == typeof r3.type) {
    var n3 = r3.__e;
    if (n3) {
      var t3 = n3.U;
      if (t3) {
        n3.U = void 0;
        for (var f3 in t3) {
          var o3 = t3[f3];
          if (o3) o3.d();
        }
      }
    }
  } else {
    var e2 = r3.__c;
    if (e2) {
      var u2 = e2.__$u;
      if (u2) {
        e2.__$u = void 0;
        u2.d();
      }
    }
  }
  i3(r3);
});
l2("__h", function(i3, r3, n3, t3) {
  if (t3 < 3 || 9 === t3) r3.__$f |= 2;
  i3(r3, n3, t3);
});
i2.prototype.shouldComponentUpdate = function(i3, r3) {
  if (this.__R) return true;
  var n3 = this.__$u, t3 = n3 && void 0 !== n3.s;
  for (var f3 in r3) return true;
  if (this.__f || "boolean" == typeof this.u && true === this.u) {
    if (!(t3 || 2 & this.__$f || 4 & this.__$f)) return true;
    if (1 & this.__$f) return true;
  } else {
    if (!(t3 || 4 & this.__$f)) return true;
    if (3 & this.__$f) return true;
  }
  for (var o3 in i3) if ("__source" !== o3 && i3[o3] !== this.props[o3]) return true;
  for (var e2 in this.props) if (!(e2 in i3)) return true;
  return false;
};
function useSignal(i3) {
  return t2(function() {
    return y(i3);
  }, []);
}
function useComputed(i3) {
  var r3 = f2(i3);
  r3.current = i3;
  v2.__$f |= 4;
  return t2(function() {
    return g(function() {
      return r3.current();
    });
  }, []);
}
function useSignalEffect(i3) {
  var r3 = f2(i3);
  r3.current = i3;
  o2(function() {
    return j(function() {
      return r3.current();
    });
  }, []);
}
export {
  l as Signal,
  n as batch,
  g as computed,
  j as effect,
  y as signal,
  o as untracked,
  useComputed,
  useSignal,
  useSignalEffect
};
