(function () {
  "use strict";

  var buyButton = document.getElementById("buy-ebook");
  var status = document.getElementById("ebook-status");
  if (!buyButton || !status) return;

  var DOWNLOAD_URL = "/api/download";
  var WHATSAPP_HELP =
    "https://wa.me/918977826933?text=Hello%20SPS%2C%20I%20paid%20for%20the%20eBook%20and%20need%20help%20with%20the%20download.";
  var lastPayment = null;
  var verifying = false;
  var paymentCompleted = false;

  function setButtonBusy(busy, label) {
    buyButton.disabled = Boolean(busy);
    buyButton.setAttribute("aria-busy", busy ? "true" : "false");
    buyButton.textContent = label || "Buy eBook – ₹199";
  }

  function renderCard(kind, title, message, actions) {
    status.textContent = "";
    var card = document.createElement("div");
    card.className = "ebook-status-card" + (kind ? " is-" + kind : "");

    var heading = document.createElement("h3");
    heading.textContent = title;
    card.appendChild(heading);

    var paragraph = document.createElement("p");
    paragraph.textContent = message;
    card.appendChild(paragraph);

    if (actions && actions.length) {
      var row = document.createElement("div");
      row.className = "ebook-status-actions";
      actions.forEach(function (action) {
        row.appendChild(action);
      });
      card.appendChild(row);
    }

    status.appendChild(card);
  }

  function actionLink(label, href, className, download) {
    var link = document.createElement("a");
    link.className = "btn " + className;
    link.href = href;
    link.textContent = label;
    if (download) link.setAttribute("download", "");
    if (/^https?:\/\//i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    return link;
  }

  function actionButton(label, onClick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-outline";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function showError(message, options) {
    options = options || {};
    var actions = [];
    if (typeof options.retry === "function") {
      actions.push(actionButton(options.retryLabel || "Try again", options.retry));
    }
    actions.push(actionLink("Get help on WhatsApp", WHATSAPP_HELP, "btn-wa"));
    renderCard("error", options.title || "We could not confirm the payment", message, actions);
  }

  function showSuccess() {
    setButtonBusy(true, "Payment received");
    renderCard(
      "success",
      "Payment successful",
      "Thank you. Your AI Automation Blueprint Book is ready to download.",
      [
        actionLink("Download Your AI Automation Blueprint Book", DOWNLOAD_URL, "btn-primary", true),
        actionLink("Need help? WhatsApp us", WHATSAPP_HELP, "btn-wa"),
      ],
    );
  }

  function showVerifying() {
    renderCard(
      "",
      "Verifying your payment",
      "Please keep this page open while we confirm the payment with Razorpay. This usually takes a few seconds.",
      [],
    );
  }

  function requestJson(url, options) {
    return fetch(url, options).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!response.ok || data.ok === false) {
            var error = new Error(data.message || "Request failed. Please try again.");
            error.code = data.code || "request_failed";
            throw error;
          }
          return data;
        });
    });
  }

  function postJson(url, payload) {
    return requestJson(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  }

  function getJson(url) {
    return requestJson(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  }

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector("script[data-razorpay-checkout]");
      var settled = false;
      var timer = setTimeout(failure, 12000);

      function succeed() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }

      function failure() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Could not load the secure checkout. Please check your connection and try again."));
      }

      if (existing && existing.dataset.failed !== "true") {
        existing.addEventListener("load", function () {
          if (window.Razorpay) succeed();
          else failure();
        });
        existing.addEventListener("error", function () {
          existing.dataset.failed = "true";
          failure();
        });
        return;
      }

      if (existing) existing.remove();

      var script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.setAttribute("data-razorpay-checkout", "true");
      script.onload = function () {
        if (window.Razorpay) succeed();
        else failure();
      };
      script.onerror = function () {
        script.dataset.failed = "true";
        script.remove();
        failure();
      };
      document.head.appendChild(script);
    });
  }

  function verifyPayment(payment) {
    if (verifying) return;
    if (!payment || !payment.razorpay_order_id || !payment.razorpay_payment_id || !payment.razorpay_signature) {
      showError("The payment details are incomplete. Please contact us on WhatsApp so we can help.", {
        title: "Payment details incomplete",
      });
      return;
    }
    verifying = true;
    setButtonBusy(true, "Verifying payment…");
    showVerifying();

    postJson("/api/verify-payment", payment)
      .then(function () {
        verifying = false;
        paymentCompleted = true;
        showSuccess();
      })
      .catch(function (error) {
        verifying = false;

        if (error.code === "payment_failed") {
          setButtonBusy(false, "Buy eBook – ₹199");
          showError(error.message || "The payment could not be completed. Please try again.", {
            title: "Payment not completed",
            retry: startCheckout,
            retryLabel: "Try checkout again",
          });
          return;
        }

        setButtonBusy(true, "Payment received – verification needed");
        var canRetry =
          error.code !== "invalid_signature" &&
          error.code !== "payment_order_mismatch" &&
          error.code !== "amount_mismatch" &&
          error.code !== "currency_mismatch" &&
          error.code !== "order_already_paid" &&
          error.code !== "purchase_refunded";

        showError(error.message || "We could not verify the payment yet.", {
          retry: canRetry
            ? function () {
                verifyPayment(lastPayment);
              }
            : null,
          retryLabel: "Retry verification",
        });
      });
  }

  function openCheckout(order) {
    if (!window.Razorpay) {
      setButtonBusy(false);
      showError("The secure checkout could not be loaded. Please try again.", {
        title: "Checkout could not start",
        retry: startCheckout,
        retryLabel: "Try checkout again",
      });
      return;
    }

    var options = {
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      order_id: order.orderId,
      name: "Sujatha Professional Services",
      description: order.productName,
      theme: { color: "#0f6b6b" },
      notes: { product_id: "ai-agent-automation-income-blueprint" },
      handler: function (response) {
        paymentCompleted = true;
        lastPayment = {
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        };
        verifyPayment(lastPayment);
      },
      modal: {
        backdropclose: false,
        ondismiss: function () {
          if (verifying || paymentCompleted) return;
          setButtonBusy(false);
          showError("Checkout closed before the payment was completed. You can try again when ready.", {
            title: "Checkout not completed",
            retry: startCheckout,
            retryLabel: "Try checkout again",
          });
        },
      },
    };

    var checkout;
    try {
      checkout = new window.Razorpay(options);
    } catch (error) {
      setButtonBusy(false);
      showError("The secure checkout could not be opened. Please try again.", {
        title: "Checkout could not start",
        retry: startCheckout,
        retryLabel: "Try checkout again",
      });
      return;
    }

    checkout.on("payment.failed", function (response) {
      var description =
        response && response.error && response.error.description
          ? response.error.description
          : "The payment could not be completed.";
      setButtonBusy(false, "Buy eBook – ₹199");
      renderCard("error", "Payment not completed", description, [
        actionButton("Try checkout again", startCheckout),
        actionLink("Get help on WhatsApp", WHATSAPP_HELP, "btn-wa"),
      ]);
    });

    setButtonBusy(true, "Complete payment in the secure window…");
    try {
      checkout.open();
    } catch (error) {
      setButtonBusy(false);
      showError("The secure checkout could not be opened. Please try again.", {
        title: "Checkout could not start",
        retry: startCheckout,
        retryLabel: "Try checkout again",
      });
    }
  }

  function startCheckout() {
    if (buyButton.disabled) return;
    status.textContent = "";
    setButtonBusy(true, "Opening secure checkout…");

    loadRazorpay()
      .then(function () {
        return postJson("/api/create-order", {});
      })
      .then(function (order) {
        openCheckout(order);
      })
      .catch(function (error) {
        setButtonBusy(false);
        showError(error.message || "We could not start checkout. Please try again or contact us on WhatsApp.", {
          title: "Checkout could not start",
          retry: startCheckout,
          retryLabel: "Try checkout again",
        });
      });
  }

  function restoreAccess() {
    getJson("/api/access")
      .then(function (data) {
        if (data && data.paid === true) showSuccess();
      })
      .catch(function () {
        return undefined;
      });
  }

  buyButton.addEventListener("click", startCheckout);
  restoreAccess();
})();
