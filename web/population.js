// Separate trace and review state; population never triggers website generation.
export function initializePopulation(
  api,
  guarded,
  invalidatePreparation,
  getBootstrap,
  getCatalog,
) {
  let populationAcceptedId,
    populationStream,
    populationSignature,
    populationRunningId;
  let populationReferenceChange = false;
  const pEl = (id) => document.getElementById(id);
  function populationQuery() {
    const [sessionId, versionId] = pEl("internal-reference").value.split("/");
    return {
      path: pEl("create-form").elements.path.value,
      description: pEl("create-form").elements.description.value,
      internalReference: sessionId ? { sessionId, versionId } : null,
      allowReferenceSuggestions: pEl("population-suggestions").checked,
      model: pEl("population-model").value,
      effort: pEl("population-effort").value,
    };
  }
  function populationIsStale() {
    return JSON.stringify(populationQuery()) !== populationSignature;
  }
  function populationInvalidate() {
    if (!populationReferenceChange) {
      populationAcceptedId = undefined;
      if (populationSignature && populationIsStale())
        pEl("population-status").textContent =
          "Inputs changed: population result is stale. Populate again or disable population to continue manually.";
    }
  }
  pEl("create-form").addEventListener("input", (event) => {
    if (
      event.target === pEl("create-form").elements.path ||
      event.target === pEl("create-form").elements.description ||
      [
        "internal-reference",
        "population-model",
        "population-effort",
        "population-suggestions",
      ].includes(event.target.id)
    )
      populationInvalidate();
  });
  pEl("population-enabled").onchange = () => {
    pEl("population-controls").hidden = !pEl("population-enabled").checked;
    if (!pEl("population-model").options.length) {
      pEl("population-model").replaceChildren(
        ...[...pEl("model").options].map((o) => o.cloneNode(true)),
      );
      pEl("population-model").value = pEl("model").value;
      populationEfforts();
      pEl("population-effort").value = pEl("effort").value;
    }
    invalidatePreparation();
  };
  function populationEfforts() {
    const model = getBootstrap().models.find(
      (m) => String(m.number) === pEl("population-model").value,
    );
    const efforts = getCatalog().find((m) => m.id === model?.id)?.reasoning
      ?.supported_efforts ?? ["high"];
    pEl("population-effort").replaceChildren(
      ...efforts.map((e) => new Option(e, e)),
    );
    pEl("population-effort").value = efforts.includes("high")
      ? "high"
      : efforts[0];
  }
  pEl("population-model").onchange = () => {
    populationEfforts();
    populationInvalidate();
  };
  pEl("population-cancel").onclick = guarded(async () => {
    if (populationRunningId)
      await api(`/populations/${populationRunningId}/cancel`, "POST", {});
  });
  pEl("populate").onclick = guarded(async () => {
    if (!pEl("create-form").reportValidity()) return;
    populationStream?.close();
    populationAcceptedId = undefined;
    const query = populationQuery();
    populationSignature = JSON.stringify(query);
    pEl("population-proposals").replaceChildren();
    pEl("population-trace").textContent = "";
    pEl("population-status").textContent = "Populating…";
    pEl("populate").disabled = true;
    try {
      const started = await api("/populations", "POST", query);
      populationRunningId = started.id;
      pEl("population-cancel").hidden = false;
      pEl("population-download").href = `/api/populations/${started.id}/trace`;
      pEl("population-download").hidden = false;
      populationStream = new EventSource(
        `/api/populations/${started.id}/events`,
      );
      const traceEvents = [];
      populationStream.onmessage = (message) => {
        const event = JSON.parse(message.data);
        traceEvents.push(event);
        // Plain text only; never render model output as executable markup.
        if (
          event.type === "provider.event" &&
          typeof event.data.delta === "string"
        )
          pEl("population-trace").textContent += event.data.delta;
        else if (event.type !== "provider.event")
          pEl("population-trace").textContent +=
            `\n\n${event.type}\n${JSON.stringify(event.data, null, 2)}`;
        if (event.type === "population.end") {
          populationStream.close();
          populationRunningId = undefined;
          pEl("populate").disabled = false;
          pEl("population-cancel").hidden = true;
          const record = event.data;
          if (record.status !== "success") {
            pEl("population-status").textContent =
              record.error || record.status;
            return;
          }
          if (populationIsStale()) {
            pEl("population-status").textContent =
              "Completed for older inputs. Result is stale; inspect the trace or Populate again.";
            return;
          }
          populationAcceptedId = record.id;
          pEl("populated-brief").value = record.result.brief;
          invalidatePreparation();
          const usage = traceEvents
            .filter((e) => e.type === "usage")
            .map((e) => e.data);
          const usageText = usage
            .map((u, i) => {
              const d = u?.inputTokensDetails ?? u?.input_tokens_details ?? {};
              return `Request ${i + 1}: input ${u?.inputTokens ?? u?.input_tokens ?? "not reported"}, output ${u?.outputTokens ?? u?.output_tokens ?? "not reported"}, cache read ${d.cachedTokens ?? d.cached_tokens ?? "not reported"}, cache write ${d.cacheWriteTokens ?? d.cache_write_tokens ?? "not reported"}`;
            })
            .join("\n");
          pEl("population-status").textContent =
            `${record.result.similarity}: ${record.result.rationale}\n${record.result.warnings.join("\n")}\nElapsed: ${((Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000).toFixed(1)}s. Provider usage:\n${usageText || "not reported"}`;
          function proposal(text, action) {
            const row = document.createElement("p"),
              label = document.createElement("span"),
              button = document.createElement("button");
            label.textContent = text;
            button.type = "button";
            button.textContent = "Accept";
            button.onclick = () => {
              if (populationIsStale()) {
                populationInvalidate();
                return;
              }
              action();
              button.disabled = true;
              invalidatePreparation();
            };
            row.append(label, button);
            pEl("population-proposals").append(row);
          }
          for (const ref of record.result.externalReferences)
            proposal(
              `${ref.url} — ${ref.reason}. Search provenance: ${ref.provenance}. Fetchability not yet verified. `,
              () => {
                if (
                  [
                    ...pEl("external-references").querySelectorAll("input"),
                  ].some((i) => i.value === ref.url)
                )
                  return;
                pEl("add-reference").click();
                pEl("external-references").lastElementChild.querySelector(
                  "input",
                ).value = ref.url;
              },
            );
          const recommendation = record.result.referenceRecommendation;
          if (
            query.allowReferenceSuggestions &&
            recommendation.action !== "retain"
          )
            proposal(
              `Generation reference: ${recommendation.action} — ${recommendation.rationale}. Referring page remains ${record.context.referringUrl ?? "none"}. `,
              () => {
                populationReferenceChange = true;
                pEl("internal-reference").value =
                  recommendation.action === "clear"
                    ? ""
                    : `${recommendation.reference.sessionId}/${recommendation.reference.versionId}`;
                populationSignature = JSON.stringify(populationQuery());
                populationReferenceChange = false;
              },
            );
        }
      };
      populationStream.onerror = () => {
        pEl("population-status").textContent =
          "Population event connection interrupted; reconnecting. The downloadable trace retains recorded events.";
      };
    } catch (error) {
      pEl("populate").disabled = false;
      pEl("population-status").textContent = String(error);
      throw error;
    }
  });
  return {
    get acceptedId() {
      return populationAcceptedId;
    },
    get stale() {
      return !!populationSignature && populationIsStale();
    },
    reset() {
      populationAcceptedId = undefined;
      populationSignature = undefined;
      pEl("populated-brief").value = "";
      pEl("population-proposals").replaceChildren();
    },
  };
}
