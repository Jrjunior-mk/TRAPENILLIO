FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY rcs ./rcs
COPY alembic ./alembic
COPY alembic.ini .
RUN useradd -m rcs && mkdir -p /app/data && chown -R rcs /app
USER rcs
EXPOSE 8000
CMD ["uvicorn", "rcs.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "120"]
