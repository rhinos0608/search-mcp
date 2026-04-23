FROM python:3.11-slim

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download model weights during build (optional, requires HF_TOKEN build arg)
ARG HF_TOKEN=""
ENV HF_TOKEN=${HF_TOKEN}
RUN if [ -n "$HF_TOKEN" ]; then \
        python -c "from transformers import AutoModel, AutoTokenizer; \
        AutoModel.from_pretrained('google/embedding-gemma-300m', token='$HF_TOKEN'); \
        AutoTokenizer.from_pretrained('google/embedding-gemma-300m', token='$HF_TOKEN')"; \
    fi

COPY main.py .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
