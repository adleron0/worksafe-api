#!/bin/zsh
# Reproduz as leituras públicas do worksafe-site (mesmo formato de query que
# src/services/api.ts monta: show em CSV, `or` como JSON). Uso:
#   test/e2e-local/site-probe.sh [base_url] [dominio]
P=${1:-http://localhost:3100}; DOM=${2:-worksafebrasil.com.br}; D=$(date +%Y-%m-%d)
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
OR1=$(enc "[{\"gte-initialDate\":\"$D\"},{\"periodClass\":\"UNLIMITED\"}]")
CID=$(curl -s "$P/classes?limit=1" | python3 -c "import json,sys;print(json.load(sys.stdin)['rows'][0]['id'])" 2>/dev/null)
SLUG=$(curl -s "$P/blog/posts/public?limit=1" | python3 -c "import json,sys;d=json.load(sys.stdin);r=d.get('rows',[]) if isinstance(d,dict) else d;print(r[0]['slug'] if r else 'x')" 2>/dev/null)
PID=$(curl -s "$P/blog/posts/public?limit=1" | python3 -c "import json,sys;d=json.load(sys.stdin);r=d.get('rows',[]) if isinstance(d,dict) else d;print(r[0]['id'] if r else 1)" 2>/dev/null)
fail=0
while read -r name url; do
  code=$(curl -s -o /tmp/site-probe.json -w "%{http_code}" "$P/$url")
  n=$(python3 -c "import json;d=json.load(open('/tmp/site-probe.json'));print(d.get('total', len(d.get('rows',[]))) if isinstance(d,dict) else len(d))" 2>/dev/null)
  if [ "$code" = 200 ]; then printf "✔ %-16s %s itens=%s\n" "$name" "$code" "$n"; else fail=1; printf "✖ %-16s %s %s\n" "$name" "$code" "$(head -c 170 /tmp/site-probe.json)"; fi
done <<LIST
home-turmas classes?limit=999&show=_count&openClass=true&company.lp_domain=$DOM&or=$OR1
turma classes?id=$CID&show=course,instructors,_count&openClass=true
turmas classes?active=true&openClass=true&show=course,_count
agenda classes?company.lp_domain=$DOM&active=true&openClass=true&gte-initialDate=$D&lte-initialDate=2027-12-31&order-initialDate=asc&show=course,_count&or=$OR1
cursos courses/list?active=true&limit=100&lp_domain=$DOM
servicos site-services?limit=999&active=true&order-name=asc
produtos site-products?limit=10&page=0&active=true&show=images&order-name=asc&lte-price=5000&gte-price=0
tema companies/public?like-system_domain=$DOM&show=state,city
blog-cat blog/categories/public?company.lp_domain=$DOM&active=true
blog-tags blog/tags/public?company.lp_domain=$DOM&active=true
blog-posts blog/posts/public?company.lp_domain=$DOM&page=0&limit=9&order-createdAt=desc&show=category,author,tags,_count
blog-post blog/posts/public/$SLUG?company.lp_domain=$DOM&show=category,author,tags
blog-comments blog/comments/public?postId=$PID&approved=true&company.lp_domain=$DOM&page=0&limit=10&show=user,replies
LIST
exit $fail
