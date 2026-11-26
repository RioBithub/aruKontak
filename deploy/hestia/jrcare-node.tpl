server {
    listen %ip%:@HTTP_PORT@;
    server_name %domain_idn% %alias_idn%;
    root %docroot%;
    access_log /var/log/nginx/domains/%domain%.log combined;
    error_log /var/log/nginx/domains/%domain%.error.log error;
    client_max_body_size 96k;

    include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;
    include %home%/%user%/conf/web/%domain%/nginx.conf_*;

    location / {
        include /usr/local/hestia/data/templates/web/nginx/jrcare-upstream.inc;
    }
}
