import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../ebook.js", import.meta.url), "utf8");

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.href = "";
    this.disabled = false;
    this._text = "";
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function collectLinks(node, links = []) {
  for (const child of node.children) {
    if (child.tagName === "a") links.push(child);
    collectLinks(child, links);
  }
  return links;
}

function findDownloadLink(status) {
  return collectLinks(status).find((link) => link.textContent === "Download Your eBook");
}

function wait(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function razorpayFactory(paymentResponse) {
  return class FakeRazorpay {
    constructor(options) {
      this.options = options;
    }

    on() {
      return this;
    }

    open() {
      this.options.handler(paymentResponse);
    }
  };
}

function createHarness(routes) {
  const buyButton = new FakeNode("button");
  const status = new FakeNode("div");
  const elements = { "buy-ebook": buyButton, "ebook-status": status };
  const calls = [];

  const document = {
    getElementById(id) {
      return elements[id] || null;
    },
    createElement(tagName) {
      return new FakeNode(tagName);
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
    head: new FakeNode("head"),
  };

  const fetchStub = async (input) => {
    const url = String(typeof input === "string" ? input : input.url).split("?")[0];
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`Unexpected fetch: ${url}`);
    return route();
  };

  const window = {
    Razorpay: routes.Razorpay,
    addEventListener() {},
  };

  new Function("window", "document", "fetch", source)(window, document, fetchStub);
  return { buyButton, status, calls };
}

test("verification response renders the Download Your eBook button", async () => {
  const orderId = "order_MOCKUI0001";
  const paymentId = "pay_MOCKUI0001";

  const harness = createHarness({
    "/api/access": () => jsonResponse({ ok: true, paid: false, pending: false }),
    "/api/create-order": () =>
      jsonResponse({
        ok: true,
        keyId: "rzp_test_mock1234",
        orderId,
        amount: 19900,
        currency: "INR",
        productName: "The AI Agent & Automation Income Blueprint",
      }),
    "/api/verify-payment": () =>
      jsonResponse({ ok: true, downloadUrl: "/api/download", orderId, paymentId }),
    Razorpay: razorpayFactory({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: "a".repeat(64),
    }),
  });

  assert.equal(harness.buyButton.disabled, false);
  harness.buyButton.listeners.click[0]();
  await wait(60);

  const download = findDownloadLink(harness.status);
  assert.ok(download, "expected a Download Your eBook link after verification");
  assert.equal(download.href, "/api/download");
  assert.equal(download.attributes.download, "");
  assert.equal(harness.buyButton.disabled, true);
  assert.equal(harness.buyButton.textContent, "Payment received");
});

test("a page refresh restores the download button from paid access", async () => {
  const harness = createHarness({
    "/api/access": () => jsonResponse({ ok: true, paid: true, downloadUrl: "/api/download" }),
  });

  await wait(30);

  const download = findDownloadLink(harness.status);
  assert.ok(download, "expected a Download Your eBook link after refresh");
  assert.equal(download.href, "/api/download");
});

test("unpaid access never renders a download link", async () => {
  const harness = createHarness({
    "/api/access": () => jsonResponse({ ok: true, paid: false, pending: false }),
  });

  await wait(30);

  assert.equal(findDownloadLink(harness.status), undefined);
  assert.equal(collectLinks(harness.status).length, 0);
});

test("checkout checks for paid access before creating another order", async () => {
  let accessCalls = 0;
  const harness = createHarness({
    "/api/access": () => {
      accessCalls += 1;
      if (accessCalls === 1) return jsonResponse({ ok: true, paid: false, pending: false });
      return jsonResponse({ ok: true, paid: true, downloadUrl: "/api/download" });
    },
    "/api/create-order": () => {
      throw new Error("create-order must not run when access is already paid");
    },
  });

  await wait(30);
  assert.equal(harness.buyButton.disabled, false);
  harness.buyButton.listeners.click[0]();
  await wait(30);

  const download = findDownloadLink(harness.status);
  assert.ok(download, "expected the existing paid access to be recovered");
  assert.equal(download.href, "/api/download");
  assert.ok(!harness.calls.includes("/api/create-order"));
});
