"""OpenTelemetry hook: no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set and the SDK is installed."""
from __future__ import annotations
import contextlib
import logging
import os

log = logging.getLogger("yv.agent")
_tracer = None


def init(service_name: str) -> None:
    global _tracer
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return
    try:  # optional dependency
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        trace.set_tracer_provider(provider)
        _tracer = trace.get_tracer(service_name)
    except Exception as e:  # pragma: no cover
        log.warning("otel disabled: %s", e)


@contextlib.contextmanager
def span(name: str, **attrs):
    if _tracer is None:
        yield None
        return
    with _tracer.start_as_current_span(name) as s:  # pragma: no cover
        for k, v in attrs.items():
            s.set_attribute(k, v)
        yield s
