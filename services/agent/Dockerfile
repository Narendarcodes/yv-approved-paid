# One image for the agent API and the worker (CMD differs).
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt requirements-media.txt ./
ARG WITH_MEDIA=1
RUN pip install -r requirements.txt && if [ "$WITH_MEDIA" = "1" ]; then pip install -r requirements-media.txt; fi
COPY app ./app
COPY fixtures ./fixtures
COPY evals ./evals
RUN useradd -m agent
USER agent
EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
